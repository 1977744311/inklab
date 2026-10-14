// ESLint flat config。只做一件事：抓未定义变量与死代码，给拆大文件、搬目录当安全网；
// 不管代码风格（缩进、换行等见 .editorconfig）。fixtures/ 是被测的 AIUI 示例工程，不在检查范围。
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', '.runs/', '.engine/', 'fixtures/'] },
  js.configs.recommended,
  {
    // 约定：以下划线开头的名字表示「有意不用」（解构时剔除字段、占位参数等）。
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
  {
    // 浏览器侧：host/、scenarios/、lib/（除 lib/node/）。故意不给 Node 全局，
    // 误用 process / Buffer 会被 no-undef 抓到，与 __tests__/boundaries.test.mjs 互为双保险。
    files: ['host/**/*.js', 'scenarios/**/*.mjs', 'lib/**/*.mjs'],
    ignores: ['lib/node/**'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['bin/**/*.mjs', 'lib/node/**/*.mjs', '__tests__/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
];
