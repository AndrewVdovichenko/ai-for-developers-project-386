import { defineConfig, devices } from '@playwright/test';

// E2E-тесты фронтенда: страница записи на этом этапе — заглушка,
// поэтому поднимается только собранный билд `apps/web` (vite preview).
export default defineConfig({
  testDir: 'apps/web/e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'yarn workspace @calendar/web preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
