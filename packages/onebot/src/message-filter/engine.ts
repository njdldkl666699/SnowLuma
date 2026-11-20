import type {
    JsonObject,
    JsonValue,
    MessageFilterConfig,
    MessageFilterContentConfig,
    MessageFilterIdConfig,
    MessageFilterOutputConfig,
} from '../types';

/** Verdict for one event against one adapter's compiled rules. */
export type EventFilterOutcome =
    | { action: 'pass' }
    | { action: 'drop'; reason: EventDropReason }
    | { action: 'rewrite'; event: JsonObject; reason: 'prefix' | 'remove_ats' };

export type EventDropReason =
    'group_id' | 'user_id' | 'content_off' | 'content_whitelist' | 'content_blacklist';

/** True when the compiled rules can never drop or rewrite an event. */
export function isPermissiveFilter(filter: CompiledMessageFilter | null): boolean {
    return filter === null;
}

interface CompiledIdFilter {
    mode: 'on' | 'off' | 'whitelist' | 'blacklist';
    ids: Set<number>;
}

function idFilterAllows(filter: CompiledIdFilter, id: number): boolean {
    if (id === 0) {
        return true;
    }

    switch (filter.mode) {
        case 'on':
            return true;
        case 'off':
            return false;
        case 'whitelist':
            return filter.ids.has(id);
        case 'blacklist':
            return !filter.ids.has(id);
    }
}

interface CompiledContentFilter {
    mode: 'on' | 'off' | 'whitelist' | 'blacklist';
    regexps: RegExp[];
    prefixes: string[];
    prefixReplace: string;
}

interface CompiledOutputFilter {
    mode: 'on' | 'off' | 'blacklist';
    regexps: RegExp[];
}

/** Compiled, inheritance-resolved message filter rules for one adapter. */
export class CompiledMessageFilter {
    readonly userId: CompiledIdFilter;
    readonly groupId: CompiledIdFilter;
    readonly privateMessage: CompiledContentFilter;
    readonly groupMessage: CompiledContentFilter;
    readonly outputMessage: CompiledOutputFilter;
    readonly removeAts: string[];

    constructor(config: Required<MessageFilterConfig>) {
        this.userId = compileIdFilter(config.userId);
        this.groupId = compileIdFilter(config.groupId);
        this.privateMessage = compileContentFilter(config.privateMessage);
        this.groupMessage = compileContentFilter(config.groupMessage);
        this.outputMessage = compileOutputFilter(config.outputMessage);
        this.removeAts = config.removeAts.filter((qq) => qq !== '');
    }

    /**
     * Apply inbound rules to one converted OneBot event. Only `message` /
     * `message_sent` events are considered; everything else passes through.
     * Rewrites never mutate the input event — a cloned event is returned.
     */
    apply(event: JsonObject): EventFilterOutcome {
        const postType = event.post_type;

        if (postType !== 'message' && postType !== 'message_sent') {
            return PASS;
        }

        const message = event.message;

        if (!Array.isArray(message)) {
            // String-format events are already derived per adapter; the canonical
            // internal event always carries an array. Nothing to match on.
            return PASS;
        }

        const messageType = event.message_type;
        let content: CompiledContentFilter;

        if (messageType === 'group') {
            if (!idFilterAllows(this.groupId, toInt(event.group_id))) {
                return { action: 'drop', reason: 'group_id' };
            }

            if (!idFilterAllows(this.userId, toInt(event.user_id))) {
                return { action: 'drop', reason: 'user_id' };
            }

            content = this.groupMessage;
        } else if (messageType === 'private') {
            if (!idFilterAllows(this.userId, toInt(event.user_id))) {
                return { action: 'drop', reason: 'user_id' };
            }

            content = this.privateMessage;
        } else {
            return PASS;
        }

        let working: JsonObject | null = null;

        if (this.removeAts.length > 0) {
            const stripped = removeAtSegments(event, this.removeAts);

            if (stripped !== event) {
                working = stripped;
            }
        }

        const target = working ?? event;

        if (content.mode === 'on') {
            return passOrRewrite(target, working !== null);
        }

        if (content.mode === 'off') {
            return { action: 'drop', reason: 'content_off' };
        }

        const prefixOutcome = matchPrefix(target, content);

        if (prefixOutcome !== null) {
            return passOrRewrite(prefixOutcome.event, true);
        }

        for (const segment of target.message as JsonValue[]) {
            if (!isTextSegment(segment)) {
                continue;
            }

            const text = String(segment.data.text ?? '').trim();
            const verdict = matchRegexList(content, text);

            if (verdict !== null) {
                return verdict.action === 'pass'
                    ? passOrRewrite(target, working !== null)
                    : { action: 'drop', reason: 'content_blacklist' };
            }
        }

        if (content.mode === 'whitelist') {
            return { action: 'drop', reason: 'content_whitelist' };
        }

        return passOrRewrite(target, working !== null);
    }

    /**
     * Apply outbound rules to a send action. Returns `false` when the action
     * must be blocked. Only message-sending actions are considered.
     */
    blocksAction(action: string, params: JsonObject): boolean {
        if (action !== 'send_msg' && action !== 'send_private_msg' && action !== 'send_group_msg') {
            return false;
        }

        if (this.outputMessage.mode === 'on') {
            return false;
        }

        if (this.outputMessage.mode === 'off') {
            return true;
        }

        if (this.outputMessage.regexps.length === 0) {
            return false;
        }

        const text = extractOutgoingText(params);

        if (text === '') {
            return false;
        }

        return this.outputMessage.regexps.some((regexp) => regexp.test(text));
    }
}

const PASS: EventFilterOutcome = { action: 'pass' };

function passOrRewrite(event: JsonObject, rewritten: boolean): EventFilterOutcome {
    return rewritten ? { action: 'rewrite', event, reason: 'remove_ats' } : PASS;
}

function compileIdFilter(config: MessageFilterIdConfig): CompiledIdFilter {
    // 'default' at account level behaves like 'on'; per-adapter 'default' is
    // resolved by resolveMessageFilter before compilation.
    const mode = config.mode === 'default' || config.mode === 'on' ? 'on' : config.mode;

    return { mode, ids: new Set(config.ids) };
}

function compileContentFilter(config: MessageFilterContentConfig): CompiledContentFilter {
    const mode = config.mode === 'default' || config.mode === 'on' ? 'on' : config.mode;

    return {
        mode,
        regexps: config.filters.map((pattern) => new RegExp(pattern, 'u')),
        prefixes: config.prefix.filter((prefix) => prefix !== ''),
        prefixReplace: config.prefixReplace,
    };
}

function compileOutputFilter(config: MessageFilterOutputConfig): CompiledOutputFilter {
    const mode = config.mode === 'default' || config.mode === 'on' ? 'on' : config.mode;

    return {
        mode,
        regexps: config.filters.map((pattern) => new RegExp(pattern, 'u')),
    };
}

interface PrefixOutcome {
    event: JsonObject;
}

function matchPrefix(event: JsonObject, content: CompiledContentFilter): PrefixOutcome | null {
    if (content.prefixes.length === 0) {
        return null;
    }

    const message = event.message;

    if (!Array.isArray(message)) {
        return null;
    }

    for (let index = 0; index < message.length; index++) {
        const segment = message[index];

        if (!isTextSegment(segment)) {
            continue;
        }

        const textOld = String(segment.data.text ?? '').trim();

        if (textOld === '') {
            return null;
        }

        const prefix = content.prefixes.find((candidate) => textOld.startsWith(candidate));

        if (prefix === undefined) {
            return null;
        }

        const text = content.prefixReplace + textOld.slice(prefix.length);
        const next = structuredClone(event);
        const segments = next.message as JsonValue[];
        const rewritten = segments[index] as { type: string; data: { text: string } };

        if (text.trim() === '') {
            segments.splice(index, 1);
        } else {
            rewritten.data.text = text;
        }

        const raw = typeof event.raw_message === 'string' ? event.raw_message : '';

        if (raw !== '') {
            next.raw_message = raw.replace(textOld, text);
        }

        return { event: next };
    }

    return null;
}

function removeAtSegments(event: JsonObject, removeAts: string[]): JsonObject {
    const message = event.message;

    if (!Array.isArray(message)) {
        return event;
    }

    let modified = false;
    const kept: JsonValue[] = [];

    for (const segment of message) {
        if (isAtSegment(segment) && removeAts.includes(atSegmentQq(segment))) {
            modified = true;
            continue;
        }

        kept.push(segment);
    }

    if (!modified) {
        return event;
    }

    const next = structuredClone(event);
    next.message = kept;

    const raw = typeof event.raw_message === 'string' ? event.raw_message : '';

    if (raw !== '') {
        next.raw_message = removeAtCqCodes(raw, removeAts);
    }

    return next;
}

function removeAtCqCodes(raw: string, removeAts: string[]): string {
    let text = raw;

    for (const qq of removeAts) {
        const pattern = new RegExp(
            `\\[CQ:at,qq=${qq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:,[^\\]]*)?\\]`,
            'gu',
        );
        text = text.replace(pattern, '');
    }

    return text;
}

function matchRegexList(
    content: CompiledContentFilter,
    text: string,
): { action: 'pass' | 'drop' } | null {
    if (text === '') {
        return null;
    }

    for (const regexp of content.regexps) {
        if (regexp.test(text)) {
            return content.mode === 'whitelist' ? { action: 'pass' } : { action: 'drop' };
        }
    }

    return null;
}

function extractOutgoingText(params: JsonObject): string {
    const raw = params.raw_message;

    if (typeof raw === 'string' && raw !== '') {
        return raw;
    }

    const message = params.message;

    if (typeof message === 'string') {
        return message;
    }

    if (Array.isArray(message)) {
        const parts: string[] = [];

        for (const segment of message) {
            if (isTextSegment(segment)) {
                parts.push(String(segment.data.text ?? ''));
            }
        }

        return parts.join('');
    }

    return '';
}

function isTextSegment(segment: unknown): segment is { type: string; data: { text?: unknown } } {
    if (typeof segment !== 'object' || segment === null) {
        return false;
    }

    const candidate = segment as { type?: unknown; data?: unknown };

    return (
        candidate.type === 'text' && typeof candidate.data === 'object' && candidate.data !== null
    );
}

function isAtSegment(segment: unknown): segment is { type: string; data: { qq?: unknown } } {
    if (typeof segment !== 'object' || segment === null) {
        return false;
    }

    const candidate = segment as { type?: unknown; data?: unknown };

    return candidate.type === 'at' && typeof candidate.data === 'object' && candidate.data !== null;
}

function atSegmentQq(segment: { type: string; data: { qq?: unknown } }): string {
    const qq = segment.data.qq;

    if (typeof qq === 'number' && Number.isInteger(qq)) {
        return String(qq);
    }

    return typeof qq === 'string' ? qq : '';
}

function toInt(value: JsonValue | undefined): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === 'string' && value !== '') {
        const parsed = Number(value);

        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return 0;
}
