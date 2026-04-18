import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: {
      TELEGRAM_NARRATOR_BOT_TOKEN: 'test-token',
    },
  },
});
