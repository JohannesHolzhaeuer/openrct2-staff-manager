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
        // tests are added (auto.ts, staff-auto.ts, ui.ts, main.ts are
        // currently untested).
        lines: 25,
        statements: 24,
        functions: 23,
        branches: 20
      }
    }
  }
});
