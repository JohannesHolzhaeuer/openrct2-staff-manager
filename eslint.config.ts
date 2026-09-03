import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
	{
		ignores: ["dist/**", "node_modules/**"],
	},
	{
		files: ["**/*.ts"],
		extends: [
			...tseslint.configs.recommendedTypeChecked,
			...tseslint.configs.strictTypeChecked,
			...tseslint.configs.stylisticTypeChecked,
		],
		languageOptions: {
			parserOptions: {
				// Every linted file is covered by a real tsconfig project
				// (src/** by tsconfig.json, tooling + test/** by
				// tsconfig.node.json), so no file falls back to the default
				// project. Both must be listed explicitly: the project service
				// only auto-discovers tsconfig.json.
				project: ["tsconfig.json", "tsconfig.node.json"],
				tsconfigRootDir: import.meta.dirname,
				ecmaVersion: 2023,
				sourceType: "module",
			},
		},
		rules: {
			"@typescript-eslint/triple-slash-reference": "off",
		},
	},
);
