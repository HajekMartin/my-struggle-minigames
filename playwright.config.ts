import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3100' },
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:3100/api/me',
    env: { PORT: '3100', SQLITE_PATH: './test-results/lobby.sqlite', NODE_ENV: 'test' },
    reuseExistingServer: false,
    timeout: 20_000
  }
});
