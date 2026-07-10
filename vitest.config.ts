import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    environmentOptions: {
      jsdom: {
        url: 'https://windowsforum.com/chatpage/',
      },
    },
  },
});
