import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: globals.node },
  },
  tseslint.configs.recommended,
  {
    /**
     * Required once a second tsconfig.json exists in web/: typescript-eslint
     * walks up looking for a root and finds two candidates, then refuses to
     * parse. Ambiguity has to be resolved explicitly — the alternative was
     * excluding web/ from the root config, which the pre-commit hook bypasses
     * anyway since it passes staged paths to eslint directly.
     */
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,tsx}"],
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
]);
