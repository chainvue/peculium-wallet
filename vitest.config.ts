import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Product source only; the root re-export barrel has nothing to execute.
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts", "src/index.ts"],
      reporter: ["text-summary", "html", "lcov"],
      // Floors set a few points below the 2026-07-14 measured coverage
      // (stmts 83.8 / branch 71.6 / funcs 87.3 / lines 83.9) so the gate is
      // stable but still catches a real regression. Ratchet upward over time.
      thresholds: {
        statements: 78,
        branches: 66,
        functions: 82,
        lines: 78,
      },
    },
  },
});
