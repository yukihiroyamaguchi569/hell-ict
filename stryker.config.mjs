/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  mutate: ["packages/domain/src/**/*.ts"],
  packageManager: "pnpm",
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.domain.config.ts",
  },
  reporters: ["clear-text", "progress"],
  thresholds: { high: 80, low: 60, break: 60 },
  concurrency: 2,
};
