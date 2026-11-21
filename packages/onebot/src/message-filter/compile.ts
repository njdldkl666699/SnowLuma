import type {
    MessageFilterConfig,
    MessageFilterContentConfig,
    MessageFilterIdConfig,
    MessageFilterOutputConfig,
} from '../types';
import { CompiledMessageFilter } from './engine';

/**
 * All-pass account defaults: every restriction off, every list empty. There is
 * deliberately no base `message` section — the account config IS the default,
 * and `privateMessage` / `groupMessage` stand alone (an adapter-level
 * `'default'` inherits the account-level counterpart of the same name).
 */
export function makeDefaultMessageFilterConfig(): MessageFilterConfig {
    return {
        userId: makeDefaultIdConfig(),
        groupId: makeDefaultIdConfig(),
        privateMessage: makeDefaultContentConfig(),
        groupMessage: makeDefaultContentConfig(),
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
        isPermissiveContentConfig(config.privateMessage) &&
        isPermissiveContentConfig(config.groupMessage) &&
        effectiveOutputMode(config.outputMessage.mode) === 'on' &&
        config.outputMessage.filters.length === 0 &&
        config.removeAts.length === 0
    );
}

/**
 * Resolve one adapter's effective rules: each section left at `'default'`
 * inherits the account-level counterpart of the same name (an absent account
 * counterpart behaves as all-pass). A present adapter config replaces the
 * account `removeAts` list (empty list = no removals). Returns `null` when
 * the result is fully permissive so hot paths can skip it.
 */
export function resolveMessageFilterConfig(
    defaults: MessageFilterConfig | undefined,
    override: MessageFilterConfig | undefined,
): MessageFilterConfig | null {
    if (!override) {
        if (!defaults || isPermissiveMessageFilterConfig(defaults)) {
            return null;
        }

        // At account level 'default' behaves like 'on'; compile that in.
        const resolved: MessageFilterConfig = {
            userId: settleIdMode(defaults.userId),
            groupId: settleIdMode(defaults.groupId),
            privateMessage: settleContentMode(defaults.privateMessage),
            groupMessage: settleContentMode(defaults.groupMessage),
            outputMessage: settleOutputMode(defaults.outputMessage),
            removeAts: defaults.removeAts,
        };

        return isPermissiveMessageFilterConfig(resolved) ? null : resolved;
    }

    const resolved: MessageFilterConfig = {
        userId:
            override.userId.mode === 'default'
                ? settleIdMode(defaults?.userId ?? makeDefaultIdConfig())
                : override.userId,
        groupId:
            override.groupId.mode === 'default'
                ? settleIdMode(defaults?.groupId ?? makeDefaultIdConfig())
                : override.groupId,
        privateMessage:
            override.privateMessage.mode === 'default'
                ? settleContentMode(defaults?.privateMessage ?? makeDefaultContentConfig())
                : override.privateMessage,
        groupMessage:
            override.groupMessage.mode === 'default'
                ? settleContentMode(defaults?.groupMessage ?? makeDefaultContentConfig())
                : override.groupMessage,
        outputMessage:
            override.outputMessage.mode === 'default'
                ? settleOutputMode(defaults?.outputMessage ?? makeDefaultOutputConfig())
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

function settleIdMode(config: MessageFilterIdConfig): MessageFilterIdConfig {
    return config.mode === 'default' ? { ...config, mode: 'on' } : config;
}

function settleContentMode(config: MessageFilterContentConfig): MessageFilterContentConfig {
    return config.mode === 'default' ? { ...config, mode: 'on' } : config;
}

function settleOutputMode(config: MessageFilterOutputConfig): MessageFilterOutputConfig {
    return config.mode === 'default' ? { ...config, mode: 'on' } : config;
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
