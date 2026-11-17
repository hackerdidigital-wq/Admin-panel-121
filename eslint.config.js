import js from '@eslint/js';
import babelParser from '@babel/eslint-parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '.data/**', '.wrangler/**'],
  },
  {
    files: ['**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'server.ts', 'tests/**/*.ts', 'vite.config.ts'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          presets: ['@babel/preset-typescript', ['@babel/preset-react', { runtime: 'automatic' }]],
        },
      },
      ecmaVersion: 2024,
      sourceType: 'module',
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...js.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'off', // Type-stripped Babel AST does not preserve useState<T> tuple inference
      'no-unused-vars': 'off', // Enforced accurately for TypeScript 7 via tsc --noEmit --noUnusedLocals
      'no-undef': 'off', // Enforced accurately by TypeScript compiler
      'no-control-regex': 'off',
    },
  },
];
