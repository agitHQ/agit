import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Builds dist/ once before any test file: several suites drive the real
    // CLI and must not run against stale output.
    globalSetup: ["test/global-setup.ts"],
  },
});
