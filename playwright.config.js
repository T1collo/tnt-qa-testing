// Credentials and API keys always come fresh from .env, overriding anything inherited: the
// dashboard starts runs from a server process that loaded .env when it started, so without
// the override an edited .env would be ignored until the dashboard restarts. The one value a
// caller sets on purpose - the environment chosen on the Run page or on the command line
// (BASE_URL) - is kept.
const explicitBaseUrl = process.env.BASE_URL;
require('dotenv').config({ override: true, quiet: true });
if (explicitBaseUrl) process.env.BASE_URL = explicitBaseUrl;
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // flows share/mutate demo data (batches, shipments) - keep deterministic
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: process.env.BASE_URL || 'https://tnt-demo.apeiro-digital.com',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: '**/partner/**',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    // TrackIQ partner portal (/partners). Its login sits behind Cloudflare Turnstile, which
    // never issues a token to a headless browser, so the setup step reuses a saved session and
    // only opens a visible browser to sign in again when that session has expired.
    {
      name: 'partner-setup',
      testDir: './tests/partner',
      testMatch: /.*\.setup\.js/,
    },
    {
      name: 'partner',
      testDir: './tests/partner',
      testMatch: /.*\.spec\.js/,
      dependencies: ['partner-setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        storageState: 'playwright/.auth/partner-facility.json',
      },
    },
  ],
});
