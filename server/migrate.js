// Applies db/migrations/*.sql in name order, each once, each in its own transaction.
// A Postgres advisory lock means two replicas starting at the same time can't both migrate.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
const LOCK_ID = 727_401;

export async function migrate(databaseUrl, log = console.log) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map(r => r.name));
    const files = (await readdir(DIR)).filter(f => f.endsWith(".sql")).sort();
    let applied = 0;
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(path.join(DIR, f), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${f} failed: ${err.message}`, { cause: err });
      }
      log(`Applied migration ${f}`);
      applied++;
    }
    if (!applied) log("Database schema is up to date");
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    await client.end();
  }
}

// `npm run migrate` uses DATABASE_URL.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (!process.env.DATABASE_URL) { console.error("Set DATABASE_URL first"); process.exit(1); }
  migrate(process.env.DATABASE_URL).catch(err => { console.error(err.message); process.exit(1); });
}
