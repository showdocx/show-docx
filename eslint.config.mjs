import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'dist-test/**', 'node_modules/**', '*.vsix'],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        acquireVsCodeApi: 'readonly',
        console: 'readonly',
        document: 'readonly',
        window: 'readonly',
        requestAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        TextEncoder: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        __filename: 'readonly',
        HTMLElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLDivElement: 'readonly',
        MessageEvent: 'readonly',
        ArrayBuffer: 'readonly',
        Uint8Array: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'eqeqeq': ['error', 'always'],
      'curly': ['error', 'all'],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    files: ['test/webview/**/*.mjs', 'playwright.config.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        window: 'readonly',
      },
    },
  },
];
