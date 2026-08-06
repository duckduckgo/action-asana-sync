import globals from 'globals'
import tseslint from 'typescript-eslint'
import jestPlugin from 'eslint-plugin-jest'
import ddgConfig from '@duckduckgo/eslint-config'

export default [
  {
    ignores: ['dist/**', 'lib/**']
  },
  {
    languageOptions: {
      globals: globals.node
    }
  },
  ...tseslint.configs.recommended,
  ...ddgConfig,
  {
    // TypeScript itself already catches undefined-symbol and unused-variable
    // bugs (and understands ambient/type-only globals like `NodeJS`, which
    // no-undef does not), so defer to the @typescript-eslint equivalents
    // here, carrying over the leniency ddg's core rule config above grants.
    files: ['**/*.ts'],
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'none',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
          vars: 'all'
        }
      ]
    }
  },
  {
    ...jestPlugin.configs['flat/recommended'],
    files: ['test/**/*.ts', 'test/**/*.js']
  }
]
