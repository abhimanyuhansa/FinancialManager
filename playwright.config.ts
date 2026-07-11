import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";
config({ path: "e2e/.env" });

export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "node node_modules/next/dist/bin/next start -p 3000",
    url: "http://localhost:3000/api/health",
    reuseExistingServer: true,
    timeout: 60_000,
    env: {
      NODE_ENV: "test",
      ENABLE_TEST_AUTH_SEED: "1",
      CRON_SECRET: process.env.CRON_SECRET ?? "",
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      NEXTAUTH_URL: process.env.NEXTAUTH_URL ?? "http://localhost:3000",
      NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET ?? "",
    },
  },
  timeout: 120_000,
  retries: 1,
  workers: 1,
  reporter: [
    ["html", { open: "never", outputFolder: "playwright-report" }],
    ["list"],
    ["json", { outputFile: "playwright-report/results.json" }],
  ],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: "e2e/setup/auth.setup.ts",
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/user.json" },
      dependencies: ["setup"],
    },
  ],
});
