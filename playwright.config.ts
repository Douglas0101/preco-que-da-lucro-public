import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI
    ? [
        ["list"],
        ["html", { open: "never" }],
        ["json", { outputFile: ".artifacts/playwright-results.json" }],
      ]
    : "list",
  use: {
    baseURL,
    storageState: ".artifacts/e2e-auth.json",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command:
      "npm run e2e:prepare && npm run build && npm run preview -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // The CI preview server has no reverse proxy in front of it. Supplying
        // a distinct documented test IP prevents unrelated projects sharing
        // Better Auth's per-IP/path buckets.
        extraHTTPHeaders: { "x-forwarded-for": "198.51.100.11" },
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        extraHTTPHeaders: { "x-forwarded-for": "198.51.100.12" },
      },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        extraHTTPHeaders: { "x-forwarded-for": "198.51.100.13" },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Pixel 7"],
        extraHTTPHeaders: { "x-forwarded-for": "198.51.100.14" },
      },
    },
  ],
});
