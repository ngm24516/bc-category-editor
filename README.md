# Better Containers Category Editor

A web editor for the Project Zomboid mod **Better Containers**: browse every item (vanilla plus Workshop
mods), change its category, and download the two `.ini` files the mod reads. Sign in with Discord to keep
your setups in your account and open them on any PC.

## How it fits together

```
Browser ──► Azure Container Apps (one container, one origin)
              ├─ /              the editor page (web/)
              ├─ /auth/discord  "Log in with Discord" (OAuth2, scope: identify)
              └─ /api           your setups (JSON)
                                   │
                                   ▼
                       Azure Database for PostgreSQL
```

- **Identity:** Discord. We store your Discord ID, username and avatar, nothing else. The Discord token is
  used once to learn who you are, then revoked.
- **Sessions:** a random token in an `HttpOnly`, `SameSite=Lax` cookie; the database keeps only its SHA-256 hash.
- **Authorization:** every user-data query runs in a transaction tagged with your user id, and Postgres
  **row-level security** (forced, even for the table owner) returns only your rows. Tests prove another
  user can't read, change or delete your data, through the API or with raw SQL.
- **CSRF:** state-changing requests must come from the site's own origin.
- **Catalog:** the base game plus every Workshop mod anyone has imported, shared by all users. Each setup picks
  which mods it uses; the editor shows the base game plus those mods' newest versions.
- Signed out, the editor still works and keeps edits (and the chosen mods) in that browser only.

## Pipeline

| When | What runs |
|---|---|
| Every pull request | **CI**: lint, API tests against a real Postgres, migrations on an empty database, container build + smoke test |
| Merge to `main` | **Deploy**: build the image once → deploy to **staging** → smoke test → **wait for approval** → same image to **production** |

Azure sign-in from GitHub uses OIDC, so no Azure password is stored in GitHub.
One-time setup: [docs/SETUP-AZURE.md](docs/SETUP-AZURE.md).

## Run it locally

You need Docker Desktop and a Discord application (see setup step 1).

```powershell
copy .env.example .env      # then fill in DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET
docker compose up --build
```

Open <http://localhost:3000>.

## Styles

The page is styled with Tailwind CSS v4. Edit `web/src/app.css`, then build `web/app.css` (not committed;
the Docker image and CI build it):

```powershell
npm run build:css     # once
npm run dev:css       # rebuild on every save while you work
```

## Tests

```powershell
docker compose up -d db
npm ci
$env:TEST_DATABASE_URL = "postgres://bc_app:bc_app@localhost:5432/bceditor_test"
npm test
npm run lint
```

## Layout

| Path | What |
|---|---|
| `web/` | The editor page |
| `seed/vanilla/` | The base game's items and icons, loaded into the catalog on start-up (built by `importer/seed_vanilla.py`) |
| `importer/` | Python that reads game and Workshop files into catalog data (scripts, translations, Better Containers rules, icons) |
| `server/` | Express app: `auth.js` (Discord + sessions), `sets.js` (setups API), `catalog.js` (shared item catalog), `migrate.js`, `app.js` (wiring) |
| `db/migrations/` | SQL migrations, applied in order on start-up (append only; never edit one that has shipped) |
| `test/` | API tests (real Postgres, fake Discord) |
| `infra/` | Bicep for all Azure resources |
| `.github/workflows/` | CI and Deploy |
