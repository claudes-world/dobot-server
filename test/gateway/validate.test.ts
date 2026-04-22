import { describe, it, expect } from 'vitest';
import { validateGatewayRules } from '../../src/gateway/validate.js';
import type { GatewayRule } from '../../src/gateway/types.js';

describe('validateGatewayRules — zero-match guard', () => {
  it('accepts rules with at least one match condition', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { chatType: 'private' } },
      { handler: 'h2', match: { userId: 1, chatId: -100 } },
    ];
    expect(() => validateGatewayRules(rules)).not.toThrow();
  });

  it('rejects a rule with empty match object', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: {} },
    ];
    expect(() => validateGatewayRules(rules)).toThrow(/empty match/);
    expect(() => validateGatewayRules(rules)).toThrow(/allow-all/);
  });

  it('includes the agent label in the error message', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: {} },
    ];
    expect(() => validateGatewayRules(rules, 'narrator')).toThrow(/agent 'narrator'/);
  });

  it('includes the rule label in the error message when present', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: {}, label: 'my-rule' },
    ];
    expect(() => validateGatewayRules(rules, 'idea-capture')).toThrow(/my-rule/);
  });

  it('includes the rule index when no label', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { chatType: 'private' } },
      { handler: 'h2', match: {} },
    ];
    expect(() => validateGatewayRules(rules)).toThrow(/index 1/);
  });

  it('reports the first bad rule (fail-fast)', () => {
    const rules: GatewayRule[] = [
      { handler: 'ok', match: { chatId: -100 } },
      { handler: 'bad1', match: {}, label: 'first-bad' },
      { handler: 'bad2', match: {}, label: 'second-bad' },
    ];
    expect(() => validateGatewayRules(rules)).toThrow(/first-bad/);
  });

  it('accepts empty rules array (no rules = no traffic, not an error)', () => {
    expect(() => validateGatewayRules([])).not.toThrow();
  });

  it('rejects requireMention: false as not a real condition (runtime matches truthy only)', () => {
    // requireMention: false contributes no runtime condition — testRule uses
    // `if (match.requireMention)` (truthy check), so `false` is equivalent to
    // the key being absent. Validator MUST treat `{ requireMention: false }`
    // as allow-all and reject it, matching the runtime semantics.
    const rules: GatewayRule[] = [
      { handler: 'h', match: { requireMention: false } },
    ];
    expect(() => validateGatewayRules(rules)).toThrow(/empty match/);
  });

  it('accepts requireMention: true as a valid condition', () => {
    const rules: GatewayRule[] = [
      { handler: 'h', match: { requireMention: true } },
    ];
    expect(() => validateGatewayRules(rules)).not.toThrow();
  });

  it('rejects a rule with missing match object (not a crash)', () => {
    const rules = [
      { handler: 'h' } as unknown as GatewayRule,
    ];
    expect(() => validateGatewayRules(rules)).toThrow(/missing the 'match' object/);
  });

  it('rejects a rule with match: null (not a crash)', () => {
    const rules = [
      { handler: 'h', match: null } as unknown as GatewayRule,
    ];
    expect(() => validateGatewayRules(rules)).toThrow(/missing the 'match' object/);
  });
});
