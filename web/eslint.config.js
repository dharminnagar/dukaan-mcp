import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

/**
 * Mirrors the root eslint.config.js's shape (`@eslint/js` recommended +
 * `typescript-eslint` recommended, non-type-checked) with `globals.browser`
 * added for React components. Lives here rather than editing the root
 * config, which is off-limits for this workspace.
 */
export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,tsx}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,tsx}"],
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // next-env.d.ts is generated and rewritten by `next dev`/`next build` —
    // its triple-slash references are Next's own required boilerplate.
    ignores: [".next/**", "next-env.d.ts"],
  },
]);
