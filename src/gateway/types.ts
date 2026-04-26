export interface MatchConditions {
  userId?: number | number[];
  chatId?: number | number[];
  threadId?: number | number[];
  chatType?: 'private' | 'group' | 'supergroup' | 'channel' | string[];
  requireMention?: boolean;
}

export interface GatewayRule {
  handler: string;
  match: MatchConditions;
  context?: Record<string, unknown>;
  label?: string;
}
