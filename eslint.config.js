// @ts-check
const globals = require("globals");
const js = require("@eslint/js");
const stylistic = require("@stylistic/eslint-plugin");
const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
	{
		ignores: ["dist/**", "node_modules/**"],
	},
	// Tooling files (CommonJS Node scripts, not part of the plugin bundle) are
	// plain JS, so the project's TS config doesn't describe them.
	{
		files: ["deploy.js", "eslint.config.js", "*.cjs", "*.mjs"],
		languageOptions: {
			sourceType: "commonjs",
			globals: globals.node,
		},
		extends: [js.configs.recommended, stylistic.configs.recommended],
		rules: {
			// -- strict (beyond core "recommended") --
			"eqeqeq": ["error", "smart"],
			"curly": ["error", "multi-line"],
			"no-eval": "error",
			"no-var": "error",
			"prefer-const": "error",
			"no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
			// -- stylistic (match the repo's tab/quote/comma style) --
			"@stylistic/indent": ["error", "tab"],
			"@stylistic/no-tabs": "off",
			"@stylistic/quotes": ["error", "double", { avoidEscape: true }],
			"@stylistic/semi": ["error", "always"],
			"@stylistic/comma-dangle": ["error", "always-multiline"],
			"@stylistic/brace-style": ["error", "1tbs"],
		},
	},
	// Plugin source and unit tests get the full type-aware treatment.
	{
		files: ["src/**/*.ts", "test/**/*.ts"],
		extends: [
			...tseslint.configs.recommendedTypeChecked,
			...tseslint.configs.strictTypeChecked,
			...tseslint.configs.stylisticTypeChecked,
		],
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["test/*.ts"],
				},
				tsconfigRootDir: __dirname,
				ecmaVersion: 2023,
				sourceType: "module",
			},
		},
		rules: {
			"@typescript-eslint/triple-slash-reference": "off",
		},
	},
);
