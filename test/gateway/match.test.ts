import { describe, it, expect } from 'vitest';
import { matchRule } from '../../src/gateway/match.js';
import type { GatewayRule } from '../../src/gateway/types.js';
import type { Context } from 'grammy';

function makeCtx(overrides: {
  userId?: number;
  chatId?: number;
  chatType?: string;
  threadId?: number;
  text?: string;
} = {}): Context {
  return {
    from: overrides.userId !== undefined ? { id: overrides.userId } : undefined,
    chat: overrides.chatId !== undefined
      ? { id: overrides.chatId, type: overrides.chatType ?? 'private' }
      : undefined,
    message: {
      ...(overrides.threadId !== undefined ? { message_thread_id: overrides.threadId } : {}),
      ...(overrides.text !== undefined ? { text: overrides.text } : {}),
    },
  } as unknown as Context;
}

describe('matchRule — single rule matching', () => {
  it('matches userId scalar', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { userId: 42 } },
    ];
    expect(matchRule(makeCtx({ userId: 42 }), rules)).toBeTruthy();
    expect(matchRule(makeCtx({ userId: 99 }), rules)).toBeNull();
  });

  it('matches userId array (OR within field)', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { userId: [1, 2, 3] } },
    ];
    expect(matchRule(makeCtx({ userId: 2 }), rules)).toBeTruthy();
    expect(matchRule(makeCtx({ userId: 4 }), rules)).toBeNull();
  });

  it('matches chatId scalar', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { chatId: -100 } },
    ];
    expect(matchRule(makeCtx({ chatId: -100, chatType: 'supergroup' }), rules)).toBeTruthy();
    expect(matchRule(makeCtx({ chatId: -200, chatType: 'supergroup' }), rules)).toBeNull();
  });

  it('matches chatId array', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { chatId: [-100, -200] } },
    ];
    expect(matchRule(makeCtx({ chatId: -200, chatType: 'group' }), rules)).toBeTruthy();
    expect(matchRule(makeCtx({ chatId: -300, chatType: 'group' }), rules)).toBeNull();
  });

  it('matches threadId scalar', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { chatId: -100, threadId: 5 } },
    ];
    expect(matchRule(makeCtx({ chatId: -100, chatType: 'supergroup', threadId: 5 }), rules)).toBeTruthy();
    expect(matchRule(makeCtx({ chatId: -100, chatType: 'supergroup', threadId: 6 }), rules)).toBeNull();
  });

  it('matches chatType scalar', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { chatType: 'private' } },
    ];
    expect(matchRule(makeCtx({ chatId: 1, chatType: 'private' }), rules)).toBeTruthy();
    expect(matchRule(makeCtx({ chatId: 1, chatType: 'supergroup' }), rules)).toBeNull();
  });

  it('matches chatType array', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { chatType: ['group', 'supergroup'] } },
    ];
    expect(matchRule(makeCtx({ chatId: 1, chatType: 'supergroup' }), rules)).toBeTruthy();
    expect(matchRule(makeCtx({ chatId: 1, chatType: 'private' }), rules)).toBeNull();
  });

  it('AND logic — all fields must match', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { chatType: 'private', userId: [1, 2] } },
    ];
    // Both conditions pass
    expect(matchRule(makeCtx({ chatId: 1, chatType: 'private', userId: 1 }), rules)).toBeTruthy();
    // chatType passes, userId fails
    expect(matchRule(makeCtx({ chatId: 1, chatType: 'private', userId: 3 }), rules)).toBeNull();
    // userId passes, chatType fails
    expect(matchRule(makeCtx({ chatId: 1, chatType: 'group', userId: 1 }), rules)).toBeNull();
  });
});

describe('matchRule — requireMention', () => {
  it('matches when bot is mentioned in text', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { requireMention: true } },
    ];
    const ctx = makeCtx({ chatId: 1, chatType: 'group', text: 'hey @mybot do this' });
    expect(matchRule(ctx, rules, 'mybot')).toBeTruthy();
  });

  it('no match when bot not mentioned', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { requireMention: true } },
    ];
    const ctx = makeCtx({ chatId: 1, chatType: 'group', text: 'hey do this' });
    expect(matchRule(ctx, rules, 'mybot')).toBeNull();
  });

  it('no match when botUsername not provided', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { requireMention: true } },
    ];
    const ctx = makeCtx({ chatId: 1, chatType: 'group', text: 'hey @mybot do this' });
    expect(matchRule(ctx, rules)).toBeNull();
  });
});

describe('matchRule — first-wins ordering', () => {
  it('returns first matching rule', () => {
    const rules: GatewayRule[] = [
      { handler: 'specific', match: { chatId: -100, threadId: 5 } },
      { handler: 'fallback', match: { chatId: -100 } },
    ];
    const specificCtx = makeCtx({ chatId: -100, chatType: 'supergroup', threadId: 5 });
    const fallbackCtx = makeCtx({ chatId: -100, chatType: 'supergroup', threadId: 9 });

    expect(matchRule(specificCtx, rules)?.handler).toBe('specific');
    expect(matchRule(fallbackCtx, rules)?.handler).toBe('fallback');
  });

  it('returns null when no rule matches', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { chatId: -100 } },
    ];
    expect(matchRule(makeCtx({ chatId: -999, chatType: 'supergroup' }), rules)).toBeNull();
  });

  it('empty rules array returns null', () => {
    expect(matchRule(makeCtx({ chatId: 1 }), [])).toBeNull();
  });
});

describe('matchRule — undefined ctx fields', () => {
  it('userId condition fails when ctx.from is undefined', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { userId: 1 } },
    ];
    const ctx = { from: undefined, chat: { id: 1, type: 'private' }, message: {} } as unknown as Context;
    expect(matchRule(ctx, rules)).toBeNull();
  });

  it('chatId condition fails when ctx.chat is undefined', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { chatId: 1 } },
    ];
    const ctx = { from: { id: 1 }, chat: undefined, message: {} } as unknown as Context;
    expect(matchRule(ctx, rules)).toBeNull();
  });

  it('threadId condition fails when message_thread_id is undefined', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { threadId: 5 } },
    ];
    const ctx = makeCtx({ chatId: -100, chatType: 'supergroup' });
    expect(matchRule(ctx, rules)).toBeNull();
  });
});
