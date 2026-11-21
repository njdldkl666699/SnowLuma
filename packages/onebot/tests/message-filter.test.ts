import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../src/types';
import { makeDefaultMessageFilterConfig } from '../src/message-filter';
import {
    compileMessageFilter,
    resolveMessageFilterConfig,
    type CompiledMessageFilter,
} from '../src/message-filter';

function compile(
    defaults?: Parameters<typeof resolveMessageFilterConfig>[0],
    override?: Parameters<typeof resolveMessageFilterConfig>[1],
): CompiledMessageFilter | null {
    return compileMessageFilter(resolveMessageFilterConfig(defaults, override));
}

function groupEvent(text: string, overrides: JsonObject = {}): JsonObject {
    return {
        post_type: 'message',
        message_type: 'group',
        group_id: 20001,
        user_id: 10001,
        message: [{ type: 'text', data: { text } }],
        raw_message: text,
        ...overrides,
    };
}

function privateEvent(text: string, overrides: JsonObject = {}): JsonObject {
    return {
        post_type: 'message',
        message_type: 'private',
        user_id: 10001,
        message: [{ type: 'text', data: { text } }],
        raw_message: text,
        ...overrides,
    };
}

describe('message filter inheritance resolution', () => {
    it('returns null for fully permissive defaults', () => {
        expect(compile()).toBeNull();
        expect(compile(makeDefaultMessageFilterConfig())).toBeNull();
    });

    it('inherits account defaults section-by-section when override modes are default', () => {
        const defaults = makeDefaultMessageFilterConfig();
        defaults.groupMessage = { mode: 'off', filters: [], prefix: [], prefixReplace: '' };

        // Adapter overrides nothing (all-default override): inherits the group rules.
        const overrideAllDefault = makeDefaultMessageFilterConfig();
        overrideAllDefault.groupMessage = {
            mode: 'default',
            filters: [],
            prefix: [],
            prefixReplace: '',
        };
        const inherited = compile(defaults, overrideAllDefault);
        expect(inherited).not.toBeNull();
        expect(inherited?.apply(groupEvent('hi')).action).toBe('drop');

        // Adapter overrides only the group section back to permissive: group
        // messages now pass even though the account default disables them.
        const override = makeDefaultMessageFilterConfig();
        override.groupMessage = { mode: 'on', filters: [], prefix: [], prefixReplace: '' };
        const overridden = compile(defaults, override);
        expect(overridden?.apply(groupEvent('hi'))?.action ?? 'pass').toBe('pass');
    });

    it('private/group sections are independent at account level', () => {
        // No base `message` section anymore: each content section stands alone.
        const cfg = makeDefaultMessageFilterConfig();
        cfg.privateMessage = {
            mode: 'blacklist',
            filters: ['bad'],
            prefix: [],
            prefixReplace: '',
        };

        const filter = compile(cfg);
        expect(filter?.apply(privateEvent('has bad word')).action).toBe('drop');
        expect(filter?.apply(groupEvent('has bad word')).action).toBe('pass');
    });
});

describe('message filter inbound rules', () => {
    it('passes non-message events through untouched', () => {
        const cfg = makeDefaultMessageFilterConfig();
        cfg.userId = { mode: 'off', ids: [] };

        const filter = compile(cfg);
        const notice: JsonObject = { post_type: 'notice', notice_type: 'group_increase' };
        expect(filter?.apply(notice).action).toBe('pass');
    });

    it('drops messages from blacklisted users and non-whitelisted users', () => {
        const blacklist = makeDefaultMessageFilterConfig();
        blacklist.userId = { mode: 'blacklist', ids: [10001] };
        expect(compile(blacklist)?.apply(privateEvent('hi')).action).toBe('drop');
        expect(compile(blacklist)?.apply(privateEvent('hi', { user_id: 10002 })).action).toBe(
            'pass',
        );

        const whitelist = makeDefaultMessageFilterConfig();
        whitelist.userId = { mode: 'whitelist', ids: [10001] };
        expect(compile(whitelist)?.apply(privateEvent('hi')).action).toBe('pass');
        expect(compile(whitelist)?.apply(privateEvent('hi', { user_id: 10002 })).action).toBe(
            'drop',
        );
    });

    it('checks group and user lists for group messages', () => {
        const cfg = makeDefaultMessageFilterConfig();
        cfg.groupId = { mode: 'blacklist', ids: [20001] };

        const filter = compile(cfg);
        expect(filter?.apply(groupEvent('hi')).action).toBe('drop');
        expect(filter?.apply(groupEvent('hi', { group_id: 20002 })).action).toBe('pass');
    });

    it('drops everything when the section mode is off', () => {
        const cfg = makeDefaultMessageFilterConfig();
        cfg.privateMessage = { mode: 'off', filters: [], prefix: [], prefixReplace: '' };

        const filter = compile(cfg);
        expect(filter?.apply(privateEvent('anything')).action).toBe('drop');
        expect(filter?.apply(groupEvent('anything')).action).toBe('pass');
    });

    it('blocks blacklist regex matches and passes the rest', () => {
        const cfg = makeDefaultMessageFilterConfig();
        cfg.privateMessage = {
            mode: 'blacklist',
            filters: ['spam\\d+'],
            prefix: [],
            prefixReplace: '',
        };

        const filter = compile(cfg);
        expect(filter?.apply(privateEvent('buy spam123 now')).action).toBe('drop');
        expect(filter?.apply(privateEvent('normal')).action).toBe('pass');
    });

    it('drops non-matching messages under whitelist mode', () => {
        const cfg = makeDefaultMessageFilterConfig();
        cfg.groupMessage = {
            mode: 'whitelist',
            filters: ['^!'],
            prefix: [],
            prefixReplace: '',
        };

        const filter = compile(cfg);
        expect(filter?.apply(groupEvent('!cmd')).action).toBe('pass');
        expect(filter?.apply(groupEvent('cmd')).action).toBe('drop');
    });

    it('matches each text segment independently in array messages', () => {
        const cfg = makeDefaultMessageFilterConfig();
        cfg.privateMessage = {
            mode: 'blacklist',
            filters: ['secret'],
            prefix: [],
            prefixReplace: '',
        };

        const event = privateEvent('hello');
        (event.message as JsonObject[]).push({ type: 'text', data: { text: 'a secret' } });
        expect(compile(cfg)?.apply(event).action).toBe('drop');
    });

    it('rewrites a matched prefix and strips it from the text and raw_message', () => {
        const cfg = makeDefaultMessageFilterConfig();
        cfg.privateMessage = {
            mode: 'blacklist',
            filters: ['never-matches'],
            prefix: ['!', '#'],
            prefixReplace: '/',
        };

        const original = privateEvent('#cmd arg');
        const outcome = compile(cfg)?.apply(original);

        expect(outcome?.action).toBe('rewrite');

        if (outcome?.action !== 'rewrite') {
            return;
        }

        expect(outcome.event.message).toEqual([{ type: 'text', data: { text: '/cmd arg' } }]);
        expect(outcome.event.raw_message).toBe('/cmd arg');
        // The input event is never mutated.
        expect(original.message).toEqual([{ type: 'text', data: { text: '#cmd arg' } }]);
        expect(original.raw_message).toBe('#cmd arg');
    });

    it('prefix pass wins over the regex verdict', () => {
        const cfg = makeDefaultMessageFilterConfig();
        cfg.privateMessage = {
            mode: 'blacklist',
            filters: ['cmd'],
            prefix: ['!'],
            prefixReplace: '',
        };

        // Would be dropped by the regex, but the prefix bypasses it.
        expect(compile(cfg)?.apply(privateEvent('!cmd')).action).toBe('rewrite');
    });

    it('removes the whole empty text segment when the prefix replacement empties it', () => {
        const cfg = makeDefaultMessageFilterConfig();
        cfg.privateMessage = {
            mode: 'blacklist',
            filters: [],
            prefix: ['#'],
            prefixReplace: '',
        };

        const outcome = compile(cfg)?.apply(privateEvent('#'));
        expect(outcome?.action).toBe('rewrite');

        if (outcome?.action !== 'rewrite') {
            return;
        }

        expect(outcome.event.message).toEqual([]);
    });

    it('removes configured at segments from message and raw_message', () => {
        const cfg = makeDefaultMessageFilterConfig();
        cfg.removeAts = ['131415'];

        const original: JsonObject = {
            post_type: 'message',
            message_type: 'group',
            group_id: 20001,
            user_id: 10001,
            message: [
                { type: 'at', data: { qq: '131415' } },
                { type: 'text', data: { text: ' hi' } },
            ],
            raw_message: '[CQ:at,qq=131415] hi',
        };

        const outcome = compile(cfg)?.apply(original);
        expect(outcome?.action).toBe('rewrite');

        if (outcome?.action !== 'rewrite') {
            return;
        }

        expect(outcome.event.message).toEqual([{ type: 'text', data: { text: ' hi' } }]);
        expect(outcome.event.raw_message).toBe(' hi');
        expect(original.message).toHaveLength(2);
    });

    it('keeps at segments whose qq is not configured', () => {
        const cfg = makeDefaultMessageFilterConfig();
        cfg.removeAts = ['131415'];

        const event = groupEvent('hi');
        (event.message as JsonObject[]).unshift({ type: 'at', data: { qq: 999 } });
        expect(compile(cfg)?.apply(event).action).toBe('pass');
    });
});

describe('message filter outbound rules', () => {
    it('blocks send actions matching the blacklist regex', () => {
        const cfg = makeDefaultMessageFilterConfig();
        cfg.outputMessage = { mode: 'blacklist', filters: ['广告'] };

        const filter = compile(cfg);
        expect(filter?.blocksAction('send_group_msg', { group_id: 1, message: '看广告' })).toBe(
            true,
        );
        expect(filter?.blocksAction('send_private_msg', { user_id: 1, message: 'ok' })).toBe(false);
        // Non-send actions are never blocked.
        expect(filter?.blocksAction('get_group_list', {})).toBe(false);
    });

    it('extracts text from raw_message, string and array message params', () => {
        const cfg = makeDefaultMessageFilterConfig();
        cfg.outputMessage = { mode: 'blacklist', filters: ['blocked'] };

        const filter = compile(cfg);
        expect(filter?.blocksAction('send_msg', { message: 'x' + 'blocked' })).toBe(true);
        expect(
            filter?.blocksAction('send_msg', {
                message: [{ type: 'text', data: { text: 'blocked' } }],
            }),
        ).toBe(true);
        expect(
            filter?.blocksAction('send_msg', {
                raw_message: 'blocked',
                message: 'irrelevant',
            }),
        ).toBe(true);
    });

    it('blocks every send action when mode is off', () => {
        const cfg = makeDefaultMessageFilterConfig();
        cfg.outputMessage = { mode: 'off', filters: [] };

        const filter = compile(cfg);
        expect(filter?.blocksAction('send_msg', { message: 'anything' })).toBe(true);
    });
});
