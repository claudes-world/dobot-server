import { describe, it, expect, vi } from 'vitest';
import { createGatewayMiddleware, getGatewayMatch } from '../../src/gateway/middleware.js';
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

describe('createGatewayMiddleware', () => {
  it('calls next() when a rule matches', async () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { chatType: 'private' } },
    ];
    const mw = createGatewayMiddleware(rules);
    const ctx = makeCtx();
    const next = vi.fn().mockResolvedValue(undefined);
    await mw(ctx, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('does NOT call next() when no rule matches (silent drop)', async () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { chatType: 'group' } },
    ];
    const mw = createGatewayMiddleware(rules);
    const ctx = makeCtx();
    const next = vi.fn().mockResolvedValue(undefined);
    await mw(ctx, next);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches matched rule to ctx via getGatewayMatch', async () => {
    const rules: GatewayRule[] = [
      { handler: 'narrator', match: { chatType: 'private', userId: 1 }, context: { foo: 'bar' }, label: 'test' },
    ];
    const mw = createGatewayMiddleware(rules);
    const ctx = makeCtx();
    await mw(ctx, vi.fn().mockResolvedValue(undefined));
    const match = getGatewayMatch(ctx);
    expect(match).toBeDefined();
    expect(match?.rule.handler).toBe('narrator');
    expect(match?.context).toEqual({ foo: 'bar' });
  });

  it('does NOT attach match when no rule matches', async () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { chatType: 'group' } },
    ];
    const mw = createGatewayMiddleware(rules);
    const ctx = makeCtx();
    await mw(ctx, vi.fn().mockResolvedValue(undefined));
    expect(getGatewayMatch(ctx)).toBeUndefined();
  });

  it('getGatewayMatch returns undefined for ctx with no middleware run', () => {
    const ctx = makeCtx();
    expect(getGatewayMatch(ctx)).toBeUndefined();
  });
});
