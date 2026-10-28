import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "real-ai.spec.ts",
  timeout: 600_000,
  workers: 1,
  projects: [{ name: "real-ai" }],
  use: { trace: "retain-on-failure" },
});
