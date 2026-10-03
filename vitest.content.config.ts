import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/content/test/**/*.test.ts"],
  },
});
