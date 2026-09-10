import { defineConfig } from "vitest/config";

process.env.NO_COLOR = "1";
process.env.CI = "1";

export default defineConfig({
	test: {
		reporters: "dot",
		coverage: {
			provider: "v8",
			// "text" for the terminal summary and "lcov" so Codecov can digest
			// it (Codecov writes the PR comment/status from the uploaded report).
			reporter: ["text", "lcov"],
			include: ["src/**/*.ts"],
			exclude: ["src/i18n/**"],
			// Floors matching current coverage, to be raised as more tests are
			// added. Enforced by vitest: a below-threshold run exits non-zero
			// and fails the build/CI. scan.ts, staff.ts and staff-auto.ts
			// remain the largest gaps.
			thresholds: {
				lines: 50,
				statements: 50,
				functions: 55,
				branches: 35,
			},
		},
	},
});
