import { describe, it, expect, vi } from 'vitest';
import { dispatchMessage } from '../../src/gateway/dispatcher.js';
import { createGatewayMiddleware } from '../../src/gateway/middleware.js';
import type { GatewayRule } from '../../src/gateway/types.js';
import type { Context } from 'grammy';

function makeCtx(overrides: Record<string, unknown> = {}): Context {
  return {
    from: { id: 1 },
    chat: { id: 1, type: 'private' },
    message: { text: 'hello' },
    ...overrides,
  } as unknown as Context;
}

async function runMiddleware(ctx: Context, rules: GatewayRule[]): Promise<void> {
  const mw = createGatewayMiddleware(rules);
  await mw(ctx, () => Promise.resolve());
}

describe('dispatchMessage', () => {
  it('invokes the matched handler with ctx and gatewayCTX', async () => {
    const rules: GatewayRule[] = [
      { handler: 'idea-capture', match: { chatType: 'private' }, context: { repo: '/tmp', folder: 'test' } },
    ];
    const ctx = makeCtx();
    await runMiddleware(ctx, rules);

    const handler = vi.fn().mockResolvedValue(undefined);
    await dispatchMessage(ctx, { 'idea-capture': handler });

    expect(handler).toHaveBeenCalledOnce();
    const [calledCtx, calledGatewayCTX] = handler.mock.calls[0] as [Context, unknown];
    expect(calledCtx).toBe(ctx);
    expect(calledGatewayCTX).toEqual({ repo: '/tmp', folder: 'test' });
  });

  it('is a no-op when no gateway match is attached (message was dropped)', async () => {
    const ctx = makeCtx();
    // No middleware run — no match attached
    const handler = vi.fn().mockResolvedValue(undefined);
    await dispatchMessage(ctx, { 'h': handler });
    expect(handler).not.toHaveBeenCalled();
  });

  it('throws when matched handler name is not in the map', async () => {
    const rules: GatewayRule[] = [
      { handler: 'missing-handler', match: { chatType: 'private' } },
    ];
    const ctx = makeCtx();
    await runMiddleware(ctx, rules);

    await expect(dispatchMessage(ctx, {})).rejects.toThrow('no handler registered for "missing-handler"');
  });

  it('passes undefined gatewayCTX when rule has no context field', async () => {
    const rules: GatewayRule[] = [
      { handler: 'narrator', match: { chatType: 'private' } },
    ];
    const ctx = makeCtx();
    await runMiddleware(ctx, rules);

    const handler = vi.fn().mockResolvedValue(undefined);
    await dispatchMessage(ctx, { narrator: handler });

    expect(handler).toHaveBeenCalledOnce();
    const [, calledGatewayCTX] = handler.mock.calls[0] as [Context, unknown];
    expect(calledGatewayCTX).toBeUndefined();
  });
});
