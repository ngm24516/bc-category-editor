import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";

const config = loadConfig();
if (config.migrateOnStart) await migrate(config.databaseUrl);

const pool = createPool(config.databaseUrl);
const app = createApp({ pool, config });

// Expired sessions are cleaned up hourly.
const sweep = setInterval(() => {
  pool.query("DELETE FROM sessions WHERE expires_at < now()").catch(err => console.warn("Session sweep failed:", err.message));
}, 3_600_000);
sweep.unref();

const server = app.listen(config.port, () => console.log(`Listening on port ${config.port} (${config.publicUrl})`));

// Container Apps sends SIGTERM before stopping a replica: finish in-flight requests, then exit.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
