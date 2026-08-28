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
				projectService: {
					allowDefaultProject: ["test/*.ts", "deploy.ts", "eslint.config.ts", "vitest.config.ts"],
				},
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
