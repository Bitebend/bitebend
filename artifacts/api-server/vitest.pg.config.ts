import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "fix-lib-db-ssr-eventemitter",
      enforce: "pre",
      transform(code, id) {
        if (id.replace(/\\/g, "/").endsWith("/lib/db/src/index.ts")) {
          return code.replace(
            'import { EventEmitter } from "events";',
            'import events from "events";\nconst EventEmitter = events.EventEmitter;',
          );
        }
        return null;
      },
    },
  ],
  resolve: {
    alias: [
      { find: "@workspace/db/schema", replacement: path.resolve(__dirname, "../../lib/db/src/schema/index.ts") },
      { find: "@workspace/db", replacement: path.resolve(__dirname, "../../lib/db/src/index.ts") },
      { find: "@workspace/api-zod", replacement: path.resolve(__dirname, "../../lib/api-zod/src/index.ts") },
      { find: "@workspace/url-utils", replacement: path.resolve(__dirname, "../../lib/url-utils/src/index.ts") },
    ],
  },
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.pg.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
