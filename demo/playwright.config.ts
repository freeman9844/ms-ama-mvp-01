import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  webServer: {
    command: "npx tsx tests/helpers/browser-server.ts",
    url: "http://127.0.0.1:3100/health",
    reuseExistingServer: false,
  },
});
