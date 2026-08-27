// ESLint 9 flat config. The codebase is CommonJS with JSDoc types; the test
// suite is TypeScript under Playwright's test runner.
const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
const prettierConfig = require('eslint-config-prettier');

module.exports = tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'test-results/**',
      '.playwright-cli/**',
      '.claude/**',
      '.playwright/**',
      // Vendored/generated and third-party surfaces we do not own.
      'scripts/**',
      'playwright-cli.js',
      'skillCheck.js',
    ],
  },
  {
    files: ['**/*.js', '**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    plugins: {},
    rules: {
      ...eslint.configs.recommended.rules,
      // Correctness first.
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'object-shorthand': ['error', 'always'],
      'prefer-template': 'error',
      'no-useless-escape': 'error',
      'no-prototype-builtins': 'error',
      'no-async-promise-executor': 'error',
      'no-await-in-loop': 'off', // Sequential browser commands are the norm here.
      'require-atomic-updates': 'error',
      // Guard rails that make agent slop obvious at review time.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node_modules/*'],
              message: 'Import packages by name, not via node_modules paths.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.name="eval"]',
          message: 'Do not use eval(); run browser code through the session instead.',
        },
        {
          selector: 'CallExpression[callee.object.name="Object"][callee.property.name="assign"]',
          message: 'Prefer object spread over Object.assign for readability.',
        },
      ],
      'no-console': ['error', { allow: ['error', 'warn', 'log'] }],
      'no-return-await': 'error',
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      curly: ['error', 'multi-line'],
    },
  },
  {
    // The Playwright config is a TS module.
    files: ['playwright.config.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The test suite is TypeScript; keep types a lint-level check only (the
    // runner already type-checks its own compilation).
    files: ['tests/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      sourceType: 'commonjs',
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...tseslint.configs.recommended[1].rules,
      '@typescript-eslint/no-explicit-any': 'off', // The upstream config objects are untyped.
      '@typescript-eslint/no-require-imports': 'off', // The suite reads CommonJS modules on purpose.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Playwright's `test('name', async ({}) => {})` idiom destructures the
      // (unused here) fixtures object; the empty pattern is intentional.
      'no-empty-pattern': 'off',
    },
  },
  {
    // Upstream-derived code: best-effort sidecar writes and JSON probes
    // deliberately swallow errors with empty catch blocks, and the
    // activateProvider wrapper relies on sequential await reassignments.
    files: ['cliEnhancements.js', 'browserProviders.js'],
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'require-atomic-updates': 'off',
      'no-return-await': 'off',
    },
  },
  {
    // Source files carry hand-written JSDoc types; require the declaration
    // comments to stay syntactically valid but do not demand type annotations
    // everywhere (upstream-style code with JSDoc @param is the convention).
    files: ['cliEnhancements.js', 'browserProviders.js'],
    rules: {
      'jsdoc/check-param-names': 'off',
    },
  },
  prettierConfig,
);
