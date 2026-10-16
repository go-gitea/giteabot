import {defineConfig} from 'eslint/config';
import json from '@eslint/json';

export default defineConfig([
  {
    files: ['**/*.json'],
    plugins: {json},
    language: 'json/json',
    extends: ['json/recommended'],
  },
  {
    files: ['tsconfig.json'],
    plugins: {json},
    language: 'json/jsonc',
    languageOptions: {
      allowTrailingCommas: true,
    },
    extends: ['json/recommended'],
  },
]);
