import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "postgres://sealdesk:sealdesk@localhost:5432/sealdesk" },
  strict: true,
  verbose: true,
});
