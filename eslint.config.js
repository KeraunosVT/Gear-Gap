// eslint.config.js — one lint config for the whole repo. `npm run lint` from
// the root; CI runs it on every PR.
//
// The point is the class of bug that a build doesn't catch and a test only
// catches if one happens to cover that line: a name used but never imported
// (Vite compiles it fine and the page crashes when that branch renders), a
// hook called conditionally, a variable that was meant to be used and isn't.
const js = require('@eslint/js');
const globals = require('globals');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');

module.exports = [
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'migrations/**'],
  },

  js.configs.recommended,

  // ── Backend: CommonJS on Node ─────────────────────────────────────────────
  {
    files: ['backend/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  // ── Frontend: ES modules and JSX in the browser ───────────────────────────
  {
    files: ['frontend/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      // Without these two, ESLint can't see that <Foo /> uses Foo — imports
      // used only as JSX would read as unused, and a missing one as fine.
      'react/jsx-uses-vars': 'error',
      'react/jsx-no-undef': 'error',
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    // Build tooling configs run in Node, not the browser.
    files: ['frontend/*.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },

  // ── Everywhere ────────────────────────────────────────────────────────────
  {
    rules: {
      // Unused function arguments are routine in Express handlers (req, res,
      // next) and callbacks; unused catch bindings are a deliberate "ignore";
      // and `const { dropped, ...rest } = row` is how a field is left out.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
    },
  },
];
