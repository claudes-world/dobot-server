import { describe, it, expect } from 'vitest';
import { matchRule } from '../../src/gateway/match.js';
import type { GatewayRule } from '../../src/gateway/types.js';
import type { Context } from 'grammy';

// Auto-generate Telegram-style `mention` entities for every `@handle` token in
// the given text. Production Telegram attaches these for any well-formed
// @username in a message body; reproducing that behaviour here keeps tests
// realistic and mirrors how the matcher consumes `ctx.msg.entities`.
function autoMentionEntities(text: string): Array<{ type: string; offset: number; length: number }> {
  const entities: Array<{ type: string; offset: number; length: number }> = [];
  const re = /@[A-Za-z0-9_]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    entities.push({ type: 'mention', offset: m.index, length: m[0].length });
  }
  return entities;
}

function makeCtx(overrides: {
  userId?: number;
  chatId?: number;
  chatType?: string;
  threadId?: number;
  text?: string;
  entities?: Array<{ type: string; offset: number; length: number }>;
} = {}): Context {
  const msgFields: Record<string, unknown> = {
    ...(overrides.threadId !== undefined ? { message_thread_id: overrides.threadId } : {}),
    ...(overrides.text !== undefined ? { text: overrides.text } : {}),
  };
  if (overrides.text !== undefined) {
    msgFields.entities = overrides.entities ?? autoMentionEntities(overrides.text);
  } else if (overrides.entities !== undefined) {
    msgFields.entities = overrides.entities;
  }
  // Populate both ctx.message and ctx.msg (grammY alias) so threadId tests work
  // regardless of update type. In production grammY populates ctx.msg automatically.
  return {
    from: overrides.userId !== undefined ? { id: overrides.userId } : undefined,
    chat: overrides.chatId !== undefined
      ? { id: overrides.chatId, type: overrides.chatType ?? 'private' }
      : undefined,
    message: msgFields,
    msg: msgFields,
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

  it('matches exact-boundary @botUsername via entities', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { requireMention: true } },
    ];
    const ctx = makeCtx({
      chatId: 1,
      chatType: 'group',
      text: 'hey @claude_do_bot help',
    });
    expect(matchRule(ctx, rules, 'claude_do_bot')).toBeTruthy();
  });

  it('no match on substring bypass @botUsername_evil (entities guard)', () => {
    // Without entity-based matching this would have passed a naive
    // text.includes("@claude_do_bot") check. The mention entity covers the
    // full "@claude_do_bot_evil" span, so strict length-equality rejects it.
    const rules: GatewayRule[] = [
      { handler: 'h', match: { requireMention: true } },
    ];
    const ctx = makeCtx({
      chatId: 1,
      chatType: 'group',
      text: 'hey @claude_do_bot_evil help',
    });
    expect(matchRule(ctx, rules, 'claude_do_bot')).toBeNull();
  });

  it('no match when @botUsername appears only as plain text (no mention entity)', () => {
    // If Telegram didn't tag the token as a mention entity (e.g. inside a
    // code block), requireMention should still reject it — exact-boundary
    // semantics require an entity.
    const rules: GatewayRule[] = [
      { handler: 'h', match: { requireMention: true } },
    ];
    const ctx = makeCtx({
      chatId: 1,
      chatType: 'group',
      text: 'hey @claude_do_bot help',
      entities: [],
    });
    expect(matchRule(ctx, rules, 'claude_do_bot')).toBeNull();
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

describe('matchRule — threadId via ctx.msg across update types', () => {
  it('matches threadId on callback_query (ctx.message is undefined, ctx.msg is set)', () => {
    const rules: GatewayRule[] = [
      { handler: 'specific', match: { chatId: -100, threadId: 5 } },
      { handler: 'fallback', match: { chatId: -100 } },
    ];
    // Simulate callback_query: ctx.message is undefined, ctx.msg has message_thread_id
    const ctx = {
      from: { id: 1 },
      chat: { id: -100, type: 'supergroup' },
      message: undefined,
      msg: { message_thread_id: 5 },
    } as unknown as Context;
    expect(matchRule(ctx, rules)?.handler).toBe('specific');
  });

  it('matches threadId on edited_message (ctx.message is undefined, ctx.msg is set)', () => {
    const rules: GatewayRule[] = [
      { handler: 'specific', match: { chatId: -100, threadId: 5 } },
      { handler: 'fallback', match: { chatId: -100 } },
    ];
    const ctx = {
      from: { id: 1 },
      chat: { id: -100, type: 'supergroup' },
      message: undefined,
      msg: { message_thread_id: 5 },
    } as unknown as Context;
    expect(matchRule(ctx, rules)?.handler).toBe('specific');
  });

  it('falls through to fallback rule when callback_query is in a different thread', () => {
    const rules: GatewayRule[] = [
      { handler: 'specific', match: { chatId: -100, threadId: 5 } },
      { handler: 'fallback', match: { chatId: -100 } },
    ];
    const ctx = {
      from: { id: 1 },
      chat: { id: -100, type: 'supergroup' },
      message: undefined,
      msg: { message_thread_id: 99 },
    } as unknown as Context;
    expect(matchRule(ctx, rules)?.handler).toBe('fallback');
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
