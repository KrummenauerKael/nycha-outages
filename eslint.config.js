import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.vercel/**', '**/test/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // The fetcher and cron route must never swallow a failure silently.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
  {
    // Plain Node scripts: no TypeScript, no bundler, no globals declared for them.
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
);
