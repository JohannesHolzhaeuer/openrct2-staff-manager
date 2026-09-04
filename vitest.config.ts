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
        // tests are added (ui.ts and main.ts are still untested; auto.ts is
        // now well covered, staff-auto.ts partially).
        lines: 38,
        statements: 37,
        functions: 37,
        branches: 30
      }
    }
  }
});
