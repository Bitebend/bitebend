import { defineConfig } from "drizzle-kit";

const dbUrl = process.env.CHAT_DATABASE_URL;
if (!dbUrl) {
  throw new Error("CHAT_DATABASE_URL is required for Drizzle Kit on chat-api");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: dbUrl,
  },
});
