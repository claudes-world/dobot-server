import { Context } from 'grammy';
import { getGatewayMatch } from './middleware.js';

export type GatewayHandler = (ctx: Context, gatewayCTX: unknown) => Promise<void>;

/**
 * Dispatch ctx to the handler named by the matched gateway rule.
 * Reads the matched rule from the WeakMap attached by the middleware.
 * No-op if no match is attached (message was dropped before reaching here).
 * Throws if the matched handler name is not in the handlers map.
 */
export async function dispatchMessage(
  ctx: Context,
  handlers: Record<string, GatewayHandler>,
): Promise<void> {
  const match = getGatewayMatch(ctx);
  if (!match) return;

  const { rule, context } = match;
  const handler = handlers[rule.handler];
  if (!handler) {
    throw new Error(`gateway: no handler registered for "${rule.handler}"`);
  }
  await handler(ctx, context);
}
