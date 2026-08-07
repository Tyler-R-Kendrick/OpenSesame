import postgres from "postgres";
import { runMigrations } from "./migrate.js";

export async function resetDatabase(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.unsafe(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO public;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
    `);
  } finally {
    await sql.end({ timeout: 5 });
  }
  await runMigrations(databaseUrl);
  console.log("Database reset and migrations re-applied.");
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required for db:reset");
    process.exit(1);
  }
  await resetDatabase(url);
}

const isCli =
  process.argv[1]?.endsWith("reset.ts") === true ||
  process.argv[1]?.endsWith("reset.js") === true;

if (isCli) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
