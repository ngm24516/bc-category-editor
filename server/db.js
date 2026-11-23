import pg from "pg";

export function createPool(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 30_000 });
  pool.on("error", err => console.error("Postgres pool error:", err.message));
  return pool;
}

// Runs fn inside a transaction where row-level security sees only this user's rows.
// set_config(..., true) scopes app.user_id to this transaction, so a pooled connection never leaks it.
export async function withUser(pool, userId, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
