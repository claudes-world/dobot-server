import { Bot } from 'grammy';

export function createBot(token: string): Bot {
  return new Bot(token);
}
