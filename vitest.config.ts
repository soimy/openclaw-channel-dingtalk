import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["tests/setup/build-feedback-worker.ts"],
    env: {
      OPENCLAW_STATE_DIR: resolve(".local/test-host"),
      OPENCLAW_CONFIG_PATH: resolve(".local/test-host/openclaw.json"),
    },
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup/reset-inbound-queue.ts", "tests/setup/reset-outbound-throttle.ts"],
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts", "index.ts"],
      exclude: ["**/*.d.ts", "tests/**"],
    },
  },
});
