import * as fs from "node:fs";
import * as path from "node:path";
import { defineConfig } from "vitest/config";

process.env.NO_COLOR = "1";
process.env.CI = "1";

// Mirror the version that bundle.ts injects (see src/globals.d.ts): vitest
// applies the same define so the plugin's registerPlugin metadata reads the
// real package.json version during tests instead of a stale hardcoded value.
const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
	version: string;
};

export default defineConfig({
	define: {
		STAFF_MANAGER_VERSION: JSON.stringify(pkg.version),
	},
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
			// and fails the build/CI. ui.ts (live-render widget closures),
			// staff.ts and main.ts remain the largest gaps.
			thresholds: {
				lines: 85,
				statements: 85,
				functions: 89,
				branches: 75,
			},
		},
	},
});
