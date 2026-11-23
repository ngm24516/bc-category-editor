using 'main.bicep'

// Non-secret settings. The two secrets are read from environment variables at deploy time,
// so they never get written into this file or the repo:
//   $env:PG_ADMIN_PASSWORD = '...'; $env:DISCORD_CLIENT_SECRET = '...'
param discordClientId = '1574225630847827988'
param adminDiscordIds = '94583691266756608'
param postgresAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD')
param discordClientSecret = readEnvironmentVariable('DISCORD_CLIENT_SECRET')
