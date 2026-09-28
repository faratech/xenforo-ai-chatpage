import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import babelParser from '@babel/eslint-parser'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default defineConfig(
  {
    ignores: ['dist/**', 'node_modules/**', 'build/**', 'coverage/**', '.claude/**'],
  },
  js.configs.recommended,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          babelrc: false,
          configFile: false,
          parserOpts: {
            plugins: ['typescript', 'jsx'],
          },
        },
      },
      globals: globals.browser,
    },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      // TypeScript 7 checks unused names and resolves type-only references.
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-restricted-syntax': ['warn', {
        selector: 'TSAnyKeyword',
        message: 'Use a specific type instead of any.',
      }],
      'react-hooks/exhaustive-deps': 'warn',
      // React Compiler-era advisory rules: surface as warnings on this pre-Compiler
      // codebase (idiomatic lazy-init effects, fallback timestamps) rather than failing lint.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        babelOptions: {
          parserOpts: {
            plugins: ['typescript'],
          },
        },
      },
    },
  },
)
