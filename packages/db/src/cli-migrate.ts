import { runMigrations } from "./migrate.ts";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

try {
  await runMigrations(url);
  console.log("migrations applied");
} catch (err: unknown) {
  console.error(err);
  process.exit(1);
}
