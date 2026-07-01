import { defineConfig } from "drizzle-kit";
import { config } from "./src/server/config.ts";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: config.databasePath,
  },
});
