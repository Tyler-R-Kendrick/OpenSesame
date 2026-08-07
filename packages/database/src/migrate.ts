import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);
  try {
    await migrate(db, { migrationsFolder: join(__dirname, "..", "drizzle") });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required for db:migrate");
    process.exit(1);
  }
  await runMigrations(url);
  console.log("Migrations applied.");
}

const isCli =
  process.argv[1]?.endsWith("migrate.ts") === true ||
  process.argv[1]?.endsWith("migrate.js") === true;

if (isCli) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
