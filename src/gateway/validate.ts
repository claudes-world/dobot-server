import type { GatewayRule } from './types.js';

/**
 * Validate a parsed gateway rules array at startup.
 * Throws on the first invalid rule so the process fails-closed rather than
 * silently routing all traffic through a zero-condition wildcard.
 */
export function validateGatewayRules(rules: GatewayRule[], agentLabel?: string): void {
  // Keys that contribute a real runtime condition when present.
  // NOTE: requireMention is excluded here and handled separately — the runtime
  // check in testRule is `if (match.requireMention)` (truthy), so an explicit
  // `requireMention: false` contributes NO condition. Counting it as present
  // would let `{ requireMention: false }` slip through as an allow-all rule.
  const CONDITION_KEYS: Array<keyof GatewayRule['match']> = [
    'chatType', 'chatId', 'threadId', 'userId',
  ];

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const label = rule.label ?? `index ${i}`;
    const agent = agentLabel ? ` in agent '${agentLabel}'` : '';

    // Defensive: a rule with missing or non-object `match` is malformed
    // and would crash with TypeError on property access below. Fail-closed
    // with a descriptive error rather than a stack trace.
    if (!rule.match || typeof rule.match !== 'object') {
      throw new Error(
        `Gateway rule '${label}'${agent} is missing the 'match' object — refusing to load. ` +
        `Every rule must declare at least one of: chatType, chatId, threadId, userId, requireMention.`,
      );
    }

    const hasCondition =
      CONDITION_KEYS.some(k => rule.match[k] !== undefined) ||
      rule.match.requireMention === true;
    if (!hasCondition) {
      throw new Error(
        `Gateway rule '${label}'${agent} has empty match — refusing to load (would allow-all). ` +
        `Add at least one of: chatType, chatId, threadId, userId, requireMention.`,
      );
    }
  }
}
