import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Module boundary enforcement.
 *
 * The architecture's central rule is that domain logic must never reach a
 * provider SDK directly - that is what made swapping the onramp provider a
 * one-package change rather than a rewrite. Nx enforces this with tags; until
 * Nx is added, these ESLint rules do the same job.
 */
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/migrations/**',
      // Tooling config, outside any package tsconfig's `include`.
      '**/drizzle.config.ts',
      // apps/web is Next.js frontend code with its own `eslint-config-next`
      // setup and tsconfig (not part of the tsconfig.base.json project graph).
      '**/apps/web/**',
    ],
  },
  {
    // Plain-JS operational scripts: Node globals, no type-aware linting.
    files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    // Provider packages may not depend on each other or on the database layer.
    files: ['packages/providers/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@pp/database', '@pp/database/*'], message: 'Providers must not touch the database. Return data; let the domain persist it.' },
            { group: ['@pp/provider-*'], message: 'Providers must not depend on other providers.' },
          ],
        },
      ],
    },
  },
  {
    // shared-types is the only thing everything may depend on. It depends on nothing.
    files: ['packages/shared-types/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@pp/*'], message: 'shared-types must have no workspace dependencies.' }] },
      ],
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true },
    },
    rules: {
      // Money is bigint. Coercing it to a number silently loses precision.
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Never parse money as a float. Use parseDecimal from @pp/shared-types.' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
