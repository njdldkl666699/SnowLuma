import { describe, expect, it } from 'vitest';
import type { ApiActionContext } from '../src/api-handler';
import { compileMessageFilter, makeDefaultMessageFilterConfig } from '../src/message-filter';
import type { JsonObject } from '../src/types';
import { createCompiledTestHandler, testAction } from './helpers/compiled-action-handler';

// ApiHandler's register* only define handlers (closures) at construction —
// they don't touch ctx — so a throwing proxy is a safe minimal context.
function fakeCtx(): ApiActionContext {
    return new Proxy({} as ApiActionContext, {
        get(_t, prop) {
            throw new Error(`ctx.${String(prop)} not stubbed`);
        },
    });
}

function blockedFilter() {
    const config = makeDefaultMessageFilterConfig();
    config.outputMessage = { mode: 'blacklist', filters: ['广告'] };
    return compileMessageFilter(config);
}

describe('ApiHandler output message filtering', () => {
    it('blocks a matching send action from a filtered source with ACTION_FAILED', async () => {
        const handler = createCompiledTestHandler(fakeCtx(), [
            testAction('send_msg', async () => ({ status: 'ok', retcode: 0, data: null })),
        ]);
        handler.setOutputFilterResolver((source) => (source === 'bot-1' ? blockedFilter() : null));

        const response = await handler.handle(
            'send_msg',
            { message: '看广告' } as JsonObject,
            undefined,
            'bot-1',
        );

        expect(response.status).toBe('failed');
        expect(response.retcode).toBe(100);
        expect(response.wording).toContain('output message filter');
    });

    it('passes non-matching send actions from the same source', async () => {
        const handler = createCompiledTestHandler(fakeCtx(), [
            testAction('send_msg', async () => ({ status: 'ok', retcode: 0, data: null })),
        ]);
        handler.setOutputFilterResolver(() => blockedFilter());

        const send = await handler.handle(
            'send_msg',
            { message: 'fine' } as JsonObject,
            undefined,
            'bot-1',
        );
        expect(send.status).toBe('ok');
    });

    it('does not block non-send actions', async () => {
        const handler = createCompiledTestHandler(fakeCtx(), [
            testAction('get_status', async () => ({ status: 'ok', retcode: 0, data: null })),
        ]);
        handler.setOutputFilterResolver(() => blockedFilter());

        const status = await handler.handle('get_status', {}, undefined, 'bot-1');
        expect(status.status).toBe('ok');
    });

    it('never blocks internal calls without a source', async () => {
        const handler = createCompiledTestHandler(fakeCtx(), [
            testAction('send_msg', async () => ({ status: 'ok', retcode: 0, data: null })),
        ]);
        handler.setOutputFilterResolver(() => blockedFilter());

        const send = await handler.handle('send_msg', { message: '广告' } as JsonObject);
        expect(send.status).toBe('ok');
    });

    it('does not block when no resolver is installed', async () => {
        const handler = createCompiledTestHandler(fakeCtx(), [
            testAction('send_msg', async () => ({ status: 'ok', retcode: 0, data: null })),
        ]);

        const send = await handler.handle(
            'send_msg',
            { message: '广告' } as JsonObject,
            undefined,
            'bot-1',
        );
        expect(send.status).toBe('ok');
    });
});
