import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['error'] }],
      // TypeScript handles undefined-symbol checking better than eslint's no-undef,
      // and no-undef doesn't understand ambient types like NodeJS.ProcessEnv.
      'no-undef': 'off',
    },
  },
  {
    files: ['test/**/*.ts', '**/*.test.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Helper scripts (debug runners, DOM discovery) — Node + browser globals,
    // no type-aware linting since these aren't part of the shipped build.
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'no-console': 'off',
      // page.evaluate bodies reference Foundry globals (fromUuid, Actor,
      // CONFIG, ui, game, …) that only exist inside the headless browser,
      // not in this Node script — eslint cannot tell the contexts apart,
      // so turn the check off for scripts entirely.
      'no-undef': 'off',
    },
  },
];
