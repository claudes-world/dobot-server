import { Context, NextFunction } from 'grammy';
import { GatewayRule } from './types.js';
import { matchRule } from './match.js';
import { getMeter } from '../lib/otel.js';

const meter = getMeter('gateway');
const gatewayDecisions = meter.createCounter('gateway_decisions', {
  description: 'Total gateway routing decisions per bot and outcome',
});

export interface GatewayMatch {
  rule: GatewayRule;
  context: Record<string, unknown> | undefined;
}

// WeakMap keyed on ctx object — attaches matched gateway result to ctx lifetime
const gatewayMatches = new WeakMap<object, GatewayMatch>();

/**
 * Read the gateway match attached to ctx by the middleware.
 * Returns undefined if the middleware hasn't run or the message was dropped.
 */
export function getGatewayMatch(ctx: Context): GatewayMatch | undefined {
  return gatewayMatches.get(ctx);
}

/**
 * Create a grammY middleware that gates messages against gateway rules.
 * No match → silent drop (next() not called).
 * Match → attaches { rule, context } to ctx via WeakMap, then calls next().
 */
export function createGatewayMiddleware(rules: GatewayRule[], botUsername?: string) {
  // Use bot username as label when available; fall back to 'unknown' (bounded).
  const botLabel = botUsername ?? 'unknown';
  return async function gatewayMiddleware(ctx: Context, next: NextFunction): Promise<void> {
    const matched = matchRule(ctx, rules, botUsername);
    if (!matched) {
      gatewayDecisions.add(1, { bot: botLabel, decision: 'no_rule' });
      return; // silent drop
    }
    gatewayDecisions.add(1, { bot: botLabel, decision: 'allow' });
    gatewayMatches.set(ctx, { rule: matched, context: matched.context });
    await next();
  };
}
