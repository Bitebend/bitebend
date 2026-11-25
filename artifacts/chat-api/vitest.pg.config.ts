import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.pg.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
