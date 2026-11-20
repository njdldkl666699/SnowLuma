import type {
    MessageFilterConfig,
    MessageFilterContentConfig,
    MessageFilterIdConfig,
    MessageFilterOutputConfig,
} from '../types';
import { CompiledMessageFilter } from './engine';

/** All-pass account defaults: every restriction off, every list empty.
 *  `privateMessage`/`groupMessage` default to `'default'` so they inherit the
 *  base `message` section, matching the OneBotFilter inheritance model. */
export function makeDefaultMessageFilterConfig(): MessageFilterConfig {
    return {
        userId: makeDefaultIdConfig(),
        groupId: makeDefaultIdConfig(),
        message: makeDefaultContentConfig(),
        privateMessage: { ...makeDefaultContentConfig(), mode: 'default' },
        groupMessage: { ...makeDefaultContentConfig(), mode: 'default' },
        outputMessage: makeDefaultOutputConfig(),
        removeAts: [],
    };
}

/** True when these rules can never drop or rewrite anything. */
export function isPermissiveMessageFilterConfig(config: MessageFilterConfig): boolean {
    return (
        effectiveIdMode(config.userId.mode) === 'on' &&
        config.userId.ids.length === 0 &&
        effectiveIdMode(config.groupId.mode) === 'on' &&
        config.groupId.ids.length === 0 &&
        isPermissiveContentConfig(config.message) &&
        isPermissiveContentConfig(config.privateMessage) &&
        isPermissiveContentConfig(config.groupMessage) &&
        effectiveOutputMode(config.outputMessage.mode) === 'on' &&
        config.outputMessage.filters.length === 0 &&
        config.removeAts.length === 0
    );
}

/**
 * Resolve one adapter's effective rules: section modes of `'default'` inherit
 * the account-level counterpart, then `privateMessage`/`groupMessage` left at
 * `'default'` inherit the resolved `message` section. A present adapter config
 * replaces the account `removeAts` list (empty list = no removals). Returns
 * `null` when the result is fully permissive so hot paths can skip it.
 */
export function resolveMessageFilterConfig(
    defaults: MessageFilterConfig | undefined,
    override: MessageFilterConfig | undefined,
): MessageFilterConfig | null {
    if (!override) {
        if (!defaults || isPermissiveMessageFilterConfig(defaults)) {
            return null;
        }

        // At account level `'default'` behaves like `'on'`; compile that in.
        const message =
            defaults.message.mode === 'default'
                ? { ...defaults.message, mode: 'on' as const }
                : defaults.message;

        const resolved: MessageFilterConfig = {
            userId:
                defaults.userId.mode === 'default'
                    ? { ...defaults.userId, mode: 'on' }
                    : defaults.userId,
            groupId:
                defaults.groupId.mode === 'default'
                    ? { ...defaults.groupId, mode: 'on' }
                    : defaults.groupId,
            message,
            privateMessage:
                defaults.privateMessage.mode === 'default' ? message : defaults.privateMessage,
            groupMessage:
                defaults.groupMessage.mode === 'default' ? message : defaults.groupMessage,
            outputMessage:
                defaults.outputMessage.mode === 'default'
                    ? { ...defaults.outputMessage, mode: 'on' as const }
                    : defaults.outputMessage,
            removeAts: defaults.removeAts,
        };

        return isPermissiveMessageFilterConfig(resolved) ? null : resolved;
    }

    const message =
        override.message.mode === 'default'
            ? (defaults?.message ?? makeDefaultContentConfig())
            : override.message;
    // 'default' on private/group first inherits the account-level counterpart,
    // and only falls back to the resolved base `message` when that is also
    // 'default' (the OneBotFilter inheritance chain).
    const resolveSection = (
        overrideSection: MessageFilterContentConfig,
        defaultsSection: MessageFilterContentConfig | undefined,
    ): MessageFilterContentConfig =>
        overrideSection.mode === 'default'
            ? defaultsSection && defaultsSection.mode !== 'default'
                ? defaultsSection
                : message
            : overrideSection;
    const resolved: MessageFilterConfig = {
        userId:
            override.userId.mode === 'default'
                ? (defaults?.userId ?? makeDefaultIdConfig())
                : override.userId,
        groupId:
            override.groupId.mode === 'default'
                ? (defaults?.groupId ?? makeDefaultIdConfig())
                : override.groupId,
        message,
        privateMessage: resolveSection(override.privateMessage, defaults?.privateMessage),
        groupMessage: resolveSection(override.groupMessage, defaults?.groupMessage),
        outputMessage:
            override.outputMessage.mode === 'default'
                ? (defaults?.outputMessage ?? makeDefaultOutputConfig())
                : override.outputMessage,
        removeAts: override.removeAts,
    };

    return isPermissiveMessageFilterConfig(resolved) ? null : resolved;
}

/** Compile resolved rules; `null` when permissive. Throws on invalid regexes
 *  (validation normally rejects them earlier). */
export function compileMessageFilter(
    config: MessageFilterConfig | null,
): CompiledMessageFilter | null {
    if (!config) {
        return null;
    }

    return new CompiledMessageFilter(config);
}

function makeDefaultIdConfig(): MessageFilterIdConfig {
    return { mode: 'on', ids: [] };
}

function makeDefaultContentConfig(): MessageFilterContentConfig {
    return { mode: 'on', filters: [], prefix: [], prefixReplace: '' };
}

function makeDefaultOutputConfig(): MessageFilterOutputConfig {
    return { mode: 'on', filters: [] };
}

function effectiveIdMode(
    mode: MessageFilterIdConfig['mode'],
): 'on' | 'off' | 'whitelist' | 'blacklist' {
    return mode === 'default' || mode === 'on' ? 'on' : mode;
}

function effectiveOutputMode(mode: MessageFilterOutputConfig['mode']): 'on' | 'off' | 'blacklist' {
    return mode === 'default' || mode === 'on' ? 'on' : mode;
}

function isPermissiveContentConfig(config: MessageFilterContentConfig): boolean {
    const mode = config.mode === 'default' || config.mode === 'on' ? 'on' : config.mode;

    return mode === 'on' && config.filters.length === 0 && config.prefix.length === 0;
}
