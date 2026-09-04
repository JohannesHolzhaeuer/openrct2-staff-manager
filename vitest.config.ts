import { defineConfig } from "vitest/config";

process.env.NO_COLOR = "1";
process.env.CI = "1";

export default defineConfig({
  test: {
    reporters: "dot",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/i18n/**"],
      thresholds: {
        // Baseline floor matching current coverage, to be raised as more
        // tests are added. auto.ts, main.ts, store.ts and ui.ts are now well
        // covered; scan.ts, staff.ts and staff-auto.ts remain the largest
        // gaps.
        lines: 44,
        statements: 43,
        functions: 51,
        branches: 35
      }
    }
  }
});
