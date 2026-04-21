import { Context, NextFunction } from 'grammy';
import { GatewayRule } from './types.js';
import { matchRule } from './match.js';

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
  return async function gatewayMiddleware(ctx: Context, next: NextFunction): Promise<void> {
    const matched = matchRule(ctx, rules, botUsername);
    if (!matched) return; // silent drop
    gatewayMatches.set(ctx, { rule: matched, context: matched.context });
    await next();
  };
}
