import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Flat config. Type-aware, deliberately narrow.
 *
 * The rule set is chosen for the failure modes THIS codebase actually has
 * rather than for coverage. It is a money path with an audit ledger, so the
 * expensive mistakes are an un-awaited write that silently loses a row, a
 * promise used as a boolean, and an `any` that lets a paise figure become a
 * float. Those are errors. Style is Prettier's job and is switched off here.
 *
 * Rules NOT enabled, and why, so nobody adds them back without reading this:
 *   - no-non-null-assertion: `products[i]!` and `rupeesPart!` are guarded by
 *     invariants the compiler cannot see (a regex match, a length check made
 *     one line earlier). Flagging them trains people to write
 *     eslint-disable comments, which is strictly worse than the assertion.
 *   - no-unnecessary-condition: too many false positives against zod-inferred
 *     types, where a runtime guard is correct even when the static type says
 *     it cannot be null.
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'web/.next/**',
      '.projectmem/**',
      'fixtures/**',
      'setup/**',
      'bun.lock',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // eslint.config.js and other root-level config files are not in
          // tsconfig's include, so the project service cannot type them.
          allowDefaultProject: ['eslint.config.js', '*.config.js', '*.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- the ones that catch real bugs here -------------------------------
      // An un-awaited writeAuditEvent loses an audit row, and the project's
      // central claim is that every money action is reconstructible from the
      // log. This is the single most valuable rule in the file.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // Money is integer paise. `any` is how a float gets in.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // The codebase already separates value and type imports everywhere;
      // this keeps it that way rather than introducing the convention.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],

      // Unused code is either a leftover or a mistake. Underscore to opt out.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // --- see the header for what is deliberately absent -------------------
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // require-await fires on correct code here. FakeRazorpayAdapter.createOrder
      // MUST be `async` to satisfy `Promise<CreateOrderResult>` and so that its
      // `throw` becomes a rejection rather than a synchronous throw, yet it
      // awaits nothing. Same for async test callbacks that only assert. The rule
      // cannot tell those from a forgotten await.
      '@typescript-eslint/require-await': 'off',
    },
  },

  // Scripts and the eval CLIs are console programs. Printing is the point.
  {
    files: ['scripts/**/*.ts', 'src/eval/generate.ts', 'src/eval/run.ts', 'src/db/migrate.ts'],
    rules: { 'no-console': 'off' },
  },

  // Tests reach into the database with raw SQL and assert on loosely typed
  // rows. Type-safety rules that are load-bearing in src/ are noise here.
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      // `await expect(p).rejects.toThrow()` is the canonical bun:test pattern and
      // is correct, but bun:test's own type declarations give those matchers a
      // `void` return rather than `Promise<void>`. So this rule flags every
      // correct async assertion in the suite. Off here, ON in src/ where it
      // catches a real forgotten-await.
      '@typescript-eslint/await-thenable': 'off',
    },
  },

  // Must stay last: switches off everything that fights Prettier.
  prettier,
);
