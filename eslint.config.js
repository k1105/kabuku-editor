import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      // Phase 0: 既存コードを壊さない warning 運用から開始。
      // Phase 1 以降で順次 error に昇格する。
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // Phase 3 のモジュール抽出で「2Dコンテキストの引数 ctx が状態オブジェクト
      // ctx をシャドーして undefined 参照になる」実バグが出たため導入。
      'no-shadow': 'warn',
    },
  },
  {
    files: ['src/core/mesh-worker.js'],
    languageOptions: {
      globals: { ...globals.worker },
    },
  },
  {
    files: ['tests/**/*.js', '*.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
