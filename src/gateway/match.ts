import { Context } from 'grammy';
import { GatewayRule } from './types.js';

function matchScalarOrArray(value: number | undefined, condition: number | number[]): boolean {
  if (value === undefined) return false;
  return Array.isArray(condition) ? condition.includes(value) : value === condition;
}

function matchStringScalarOrArray(value: string | undefined, condition: string | string[]): boolean {
  if (value === undefined) return false;
  return Array.isArray(condition) ? condition.includes(value) : value === condition;
}

/**
 * Test a single rule against the incoming ctx.
 * All specified match fields must satisfy (AND logic).
 * Returns true if all conditions pass.
 */
function testRule(ctx: Context, rule: GatewayRule, botUsername?: string): boolean {
  const { match } = rule;

  if (match.userId !== undefined) {
    const userId = ctx.from?.id;
    if (!matchScalarOrArray(userId, match.userId)) return false;
  }

  if (match.chatId !== undefined) {
    const chatId = ctx.chat?.id;
    if (!matchScalarOrArray(chatId, match.chatId)) return false;
  }

  if (match.threadId !== undefined) {
    // ctx.msg normalises across update types (message, edited_message, callback_query, etc.)
    // ctx.message is undefined on callback_query/edited_message — do NOT use it here.
    const threadId = ctx.msg?.message_thread_id;
    if (!matchScalarOrArray(threadId, match.threadId)) return false;
  }

  if (match.chatType !== undefined) {
    const chatType = ctx.chat?.type;
    if (!matchStringScalarOrArray(chatType, match.chatType)) return false;
  }

  if (match.requireMention) {
    if (!botUsername) return false;
    // Use Telegram mention entities for exact-boundary match. This prevents
    // substring bypass where "@botUsername_evil" would satisfy a naive
    // text.includes("@botUsername") check. Entities give exact offset+length
    // bounds that Telegram itself assigns when rendering the mention.
    const text = ctx.msg?.text ?? ctx.msg?.caption ?? '';
    const entities = ctx.msg?.entities ?? ctx.msg?.caption_entities ?? [];
    const mentionTag = `@${botUsername}`;
    const mentioned = entities.some(
      (e) => e.type === 'mention' && text.slice(e.offset, e.offset + e.length) === mentionTag,
    );
    if (!mentioned) return false;
  }

  return true;
}

/**
 * Find the first rule in rules[] that matches ctx.
 * Returns the matched rule or null if none match.
 */
export function matchRule(ctx: Context, rules: GatewayRule[], botUsername?: string): GatewayRule | null {
  for (const rule of rules) {
    if (testRule(ctx, rule, botUsername)) return rule;
  }
  return null;
}
