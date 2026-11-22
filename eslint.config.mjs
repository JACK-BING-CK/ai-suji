import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import vue from 'eslint-plugin-vue'
import ts from 'typescript-eslint'

export default defineConfig([
  { ignores: ['**/dist/', '**/unpackage/', '**/.husky/_/'] },
  js.configs.recommended,
  {
    files: ['**/*.{ts,vue}'],
    extends: [ts.configs.recommended],
  },
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: ts.parser } },
    rules: { 'no-undef': 'off' },
  },
  {
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-empty-object-type': [
        'error',
        { allowInterfaces: 'with-single-extends' },
      ],
    },
  },
  {
    files: ['src/pages/**/index.vue'],
    rules: { 'vue/multi-word-component-names': 'off' },
  },
  prettier,
])
