import baseConfig from "./eslint.config.js";

// Observes file and function length as warnings (AGENTS.md「静的解析は複雑さを止めるために使う」).
// Kept out of eslint.config.js because `pnpm lint` fails on any warning.
// Thresholds sit near the p95 of the source code measured on 2026-10-23 (files 314, functions 25 lines).
export default [
  ...baseConfig,
  {
    files: ["apps/*/src/**/*.{ts,vue}", "packages/domain/src/**/*.ts"],
    rules: {
      "max-lines": ["warn", { max: 300, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["warn", { max: 50, skipBlankLines: true, skipComments: true }],
    },
  },
];
