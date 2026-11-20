import { describe, expect, it } from 'vitest';
import {
    IOneBotNetworkAdapter,
    OneBotNetworkManager,
    type AdapterStatus,
    type NetworkAdapterContext,
    type NetworkAdapterKind,
} from '../src/network';
import type { DispatchPayload } from '../src/event-filter';
import { makeDefaultMessageFilterConfig } from '../src/message-filter';
import type { JsonObject, MessageFilterConfig, NetworkBase, OneBotConfig } from '../src/types';

const CTX: NetworkAdapterContext = {
    uin: '10001',
    api: {} as never,
    buildLifecycleEvent: () => ({}),
    buildHeartbeatEvent: () => ({}),
};

/** Records every dispatched payload; active as long as `open()` ran. */
class RecordingAdapter extends IOneBotNetworkAdapter<NetworkBase> {
    readonly events: Array<{ event: JsonObject; payload: DispatchPayload }> = [];

    constructor(
        name: string,
        config: NetworkBase,
        readonly kind: NetworkAdapterKind,
    ) {
        super(name, config, CTX);
    }

    async open(): Promise<void> {
        this.isEnabled = true;
    }

    async close(): Promise<void> {
        this.isEnabled = false;
    }

    protected bindingSignature(): string {
        return this.name;
    }

    describeStatus(): AdapterStatus {
        return {
            name: this.name,
            kind: this.kind,
            status: this.isActive ? 'ok' : 'disabled',
            detail: this.isActive ? 'active' : 'disabled',
        };
    }

    onEvent(event: JsonObject, payload: DispatchPayload): void {
        this.events.push({ event, payload });
    }
}

function baseNetwork(name: string, messageFilter?: MessageFilterConfig): NetworkBase {
    return {
        name,
        messageFormat: 'array',
        reportSelfMessage: false,
        ...(messageFilter ? { messageFilter } : {}),
    };
}

function configWith(
    defaults: MessageFilterConfig,
    _adapters: Array<{ name: string; messageFilter?: MessageFilterConfig }>,
): OneBotConfig {
    return {
        networks: {
            httpServers: [],
            httpClients: [],
            wsServers: [],
            wsClients: [],
        },
        statusCommand: { enabled: false, swallow: false, cooldownSeconds: 0, trigger: '#sl' },
        historySync: { enabled: false },
        notifications: { channelIds: [] },
        messageFilter: defaults,
    };
}

async function managerWith(
    defaults: MessageFilterConfig,
    adapters: Array<{ name: string; messageFilter?: MessageFilterConfig }>,
): Promise<{ manager: OneBotNetworkManager; get: (name: string) => RecordingAdapter }> {
    const manager = new OneBotNetworkManager(
        (desired) => new RecordingAdapter(desired.name, desired.config, 'httpClient'),
    );
    const config = configWith(defaults, adapters);
    config.networks.httpClients.push(
        ...adapters.map((adapter) => ({
            ...(adapter.messageFilter
                ? { ...baseNetwork(adapter.name), messageFilter: adapter.messageFilter }
                : baseNetwork(adapter.name)),
            url: `http://localhost/${adapter.name}`,
        })),
    );
    await manager.reconcile(config);

    const get = (name: string): RecordingAdapter =>
        manager.get(name) as unknown as RecordingAdapter;

    return { manager, get };
}

function groupMessage(text: string): JsonObject {
    return {
        post_type: 'message',
        message_type: 'group',
        group_id: 20001,
        user_id: 10001,
        message: [{ type: 'text', data: { text } }],
        raw_message: text,
    };
}

describe('network manager per-adapter message filtering', () => {
    it('delivers the shared payload to adapters without rules', async () => {
        const defaults = makeDefaultMessageFilterConfig();
        const { manager, get } = await managerWith(defaults, [{ name: 'plain' }]);
        const event = groupMessage('hello');

        await manager.emitEvent(event);

        expect(get('plain').events).toHaveLength(1);
        expect(get('plain').events[0].event).toBe(event);
    });

    it('drops an event for one adapter while another still receives it', async () => {
        const defaults = makeDefaultMessageFilterConfig();
        defaults.groupMessage = { mode: 'off', filters: [], prefix: [], prefixReplace: '' };

        // 'strict' inherits the account defaults; 'relaxed' overrides to pass.
        const relaxed = makeDefaultMessageFilterConfig();
        relaxed.groupMessage = { mode: 'on', filters: [], prefix: [], prefixReplace: '' };

        const { manager, get } = await managerWith(defaults, [
            { name: 'strict' },
            { name: 'relaxed', messageFilter: relaxed },
        ]);
        await manager.emitEvent(groupMessage('hello'));

        expect(get('strict').events).toHaveLength(0);
        expect(get('relaxed').events).toHaveLength(1);
    });

    it('delivers a rewritten event without mutating the original', async () => {
        const defaults = makeDefaultMessageFilterConfig();
        defaults.removeAts = ['131415'];

        const { manager, get } = await managerWith(defaults, [{ name: 'rewritten' }]);
        const original: JsonObject = {
            post_type: 'message',
            message_type: 'private',
            user_id: 10001,
            message: [
                { type: 'at', data: { qq: '131415' } },
                { type: 'text', data: { text: ' hi' } },
            ],
            raw_message: '[CQ:at,qq=131415] hi',
        };

        await manager.emitEvent(original);

        const delivered = get('rewritten').events[0];
        expect(JSON.parse(delivered.payload.arrayJson).message).toEqual([
            { type: 'text', data: { text: ' hi' } },
        ]);
        // The canonical event object stays untouched for history/debug taps.
        expect(original.message).toHaveLength(2);
        expect(original.raw_message).toBe('[CQ:at,qq=131415] hi');
    });

    it('resolves the outbound filter by adapter name for action blocking', async () => {
        const defaults = makeDefaultMessageFilterConfig();
        defaults.outputMessage = { mode: 'blacklist', filters: ['广告'] };

        const { manager } = await managerWith(defaults, [{ name: 'blocked' }]);

        expect(
            manager.getMessageFilter('blocked')?.blocksAction('send_msg', { message: '广告' }),
        ).toBe(true);
        expect(manager.getMessageFilter('unknown-adapter')).toBeNull();
    });

    it('recompiles rules on reconcile so hot reload takes effect', async () => {
        const defaults = makeDefaultMessageFilterConfig();
        const { manager, get } = await managerWith(defaults, [{ name: 'hot' }]);
        await manager.emitEvent(groupMessage('hello'));
        expect(get('hot').events).toHaveLength(1);

        const next = makeDefaultMessageFilterConfig();
        next.privateMessage = { mode: 'off', filters: [], prefix: [], prefixReplace: '' };
        next.groupMessage = { mode: 'off', filters: [], prefix: [], prefixReplace: '' };
        const config = configWith(next, [{ name: 'hot' }]);
        config.networks.httpClients.push({
            name: 'hot',
            url: 'http://localhost/hot',
            messageFormat: 'array',
            reportSelfMessage: false,
        });
        await manager.reconcile(config);
        get('hot').events.length = 0;

        await manager.emitEvent(groupMessage('hello'));
        expect(get('hot').events).toHaveLength(0);
    });
});
