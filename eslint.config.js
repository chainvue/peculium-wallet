// ESLint flat config — verus-rpc/v402 conventions, single package.
//
// Two tiers:
// - src/ and test/ get TYPE-CHECKED linting (projectService resolves
//   tsconfig.json) — no-floating-promises matters in a wallet.
// - Root config files get the syntactic recommended set only.
//
// no-console is an ERROR in src: the MCP server owns stdout (protocol!)
// and diagnostics go to stderr via explicit process.stderr.write; the CLI
// modules (src/cli/) are the human terminal surface and are exempt.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "coverage/"],
  },
  {
    files: ["**/*.ts", "**/*.js", "**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: { globals: globals.node },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["src/**/*.ts", "test/**/*.ts"],
  })),
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-console": "error",
    },
  },
  {
    files: ["src/cli/**/*.ts", "test/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["*.config.ts"],
  })),
);
