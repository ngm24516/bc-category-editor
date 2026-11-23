// All settings come from environment variables, so the same image runs locally, in CI, in staging and in production.
// Secrets (DISCORD_CLIENT_SECRET, DATABASE_URL) are injected by Container Apps secrets, never committed.

function required(name, env) {
  const v = env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export function loadConfig(env = process.env) {
  const publicUrl = required("PUBLIC_URL", env).replace(/\/+$/, "");
  const secure = publicUrl.startsWith("https://");
  return {
    port: Number(env.PORT || 3000),
    publicUrl,
    secure,
    databaseUrl: required("DATABASE_URL", env),
    discord: {
      clientId: required("DISCORD_CLIENT_ID", env),
      clientSecret: required("DISCORD_CLIENT_SECRET", env),
      redirectUri: `${publicUrl}/auth/discord/callback`,
      // Overridable only so tests can point at a fake Discord.
      authorizeUrl: env.DISCORD_AUTHORIZE_URL || "https://discord.com/oauth2/authorize",
      apiBase: (env.DISCORD_API_BASE || "https://discord.com/api").replace(/\/+$/, ""),
    },
    // Overridable only so tests can point at a fake Steam.
    steamApiBase: env.STEAM_API_BASE || "https://api.steampowered.com",
    adminDiscordIds: new Set((env.ADMIN_DISCORD_IDS || "").split(",").map(s => s.trim()).filter(Boolean)),
    sessionDays: Number(env.SESSION_DAYS || 30),
    migrateOnStart: env.MIGRATE_ON_START !== "false",
    // Cookie names: the __Host- prefix makes the browser refuse the cookie unless it is Secure, host-only and Path=/.
    cookies: {
      session: secure ? "__Host-bc_session" : "bc_session",
      state: secure ? "__Host-bc_oauth" : "bc_oauth",
    },
  };
}
