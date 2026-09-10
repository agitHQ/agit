import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Builds dist/ once before any test file: several suites drive the real
    // CLI and must not run against stale output.
    globalSetup: ["test/global-setup.ts"],
    /**
     * Most suites here drive the real CLI, so a single test can spawn twenty
     * Node processes. Vitest's 5s default is comfortable on an idle machine
     * and not on a loaded one: a full run under contention failed 48 tests on
     * timeouts and then passed 574 twice on clean runs. CI runs on shared
     * runners, so that is flake waiting to happen.
     *
     * 30s is far above anything these tests legitimately need and far below
     * "never finishes", so a real hang still fails — just later. Individual
     * tests that need longer still say so themselves.
     */
    testTimeout: 30_000,
  },
});
