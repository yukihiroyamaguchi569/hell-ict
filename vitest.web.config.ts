import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/web/test/**/*.test.ts"],
    // The composables need Vue's reactivity only; browser APIs come in through ports.
    environment: "node",
  },
});
