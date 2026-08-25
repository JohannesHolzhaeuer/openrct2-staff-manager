// @ts-check
const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  {
	ignores: ["dist/**", "node_modules/**"],
  },
  ...tseslint.configs.recommended,
  {
	languageOptions: {
	  parserOptions: {
		ecmaVersion: 2023,
		sourceType: "module",
	  },
	},
	rules: {
	  "@typescript-eslint/triple-slash-reference": "off",
	},
  }
);
