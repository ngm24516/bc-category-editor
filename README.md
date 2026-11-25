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
- **Importing:** signed-in users paste a Workshop mod or collection link. The API asks Steam what it is and
  queues what the catalog lacks; the **importer** (`importer/worker.py`, an Azure Container Apps Job) downloads
  each item anonymously with SteamCMD, reads its files and writes a new catalog version. Every request is
  recorded against the account that made it, and each mod shows who first added it. Limits: 10 new mods or
  1 collection a day per user (admins exempt). An hourly job queues new versions of mods that changed.
- **Mod features:** while importing, the importer also notes tools a mod provides, from its file names
  (`importer/pzcatalog/features.py`, stored in `mod_versions.features`). The editor shows **Stockroom books…**
  only when a mod in the setup ships Stockroom (`media/lua/*/Stockroom/Storage.lua`).
- **Marketplace prices** (`server/market.js`, `importer/market.py`, migration 006): admins add an in-game
  marketplace's listings API on the dashboard (checked first; https and public addresses only). The hourly
  `<app>-market` job reads every page and stores each listing once per price (`market_listings`). Each account
  picks a marketplace (`user_marketplaces`, RLS) and the item list gets **Avg / Low / High** columns over the
  whole history, plus **Now**: the cheapest listing in the last full read (`last_seen = last_crawl_at`) and its
  owner. All sortable, for items whose full type is exactly a library item. Prices are per item.
- **Stockroom inventory** (`server/stockroom.js`, migration 007): when a mod with Stockroom is in the setup (found
  by its files or its mod.info id `Stockroom`), the avatar menu links to **/stockroom** (`web/stockroom.html`, its own
  page like `/admin`; names and icons via `POST /api/catalog/lookup`). Users import their Stockroom save
  (`%USERPROFILE%\Zomboid\Lua\Stockroom`); the page decodes it (`web/stockroom-codec.js`, shared with the
  editor's Stockroom books tool) and saves only each character's item totals to
  the account (`stockroom_characters`, RLS). The view lists every item with quantity, Avg / Low / High market price
  and value (quantity × average), sortable and searchable.
- **Weight and ATM columns:** every item shows its script `Weight` (the game's 1.0 when unset). When a mod with an
  ATM is in the setup (Server Economy: `HZEconomySellables.lua`, mod id `ServerEconomy`), an **ATM** column shows
  what the ATM pays for one: `baseValue` × the **ATM sell %** in the sidebar (the server's `SellValuePercent`,
  25 by default). The importer reads the table as text (`importer/pzcatalog/economy.py`); each update of the mod
  is a new version with its whole current table, and the editor only uses the newest. Versions record a data
  `format` (2 = weights and ATM values): the base game seed loads again, and the hourly check re-imports mods
  still in format 1 once.
- **Admin dashboard** (`/admin`, `web/admin.html` + `server/admin.js`): for the Discord ids in
  `ADMIN_DISCORD_IDS`. Shows the queue, when the importer and the hourly update check run next and last, every
  finished import with its worker log, and each importer run (`importer_runs`). Every mod whose latest import
  failed is listed with Retry and Retry all; admins also get Retry on failed imports in the editor's Mods dialog.
  Everyone else gets 403; the account menu at the top right links there for admins only.
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
| `importer/` | `pzcatalog/` reads game and Workshop files into catalog data; `worker.py` is the import job and hourly update check |
| `Dockerfile.importer` | The importer image: SteamCMD + Python |
| `server/` | Express app: `auth.js` (Discord + sessions), `sets.js` (setups API), `catalog.js` (shared item catalog), `imports.js` + `steam.js` (import requests), `migrate.js`, `app.js` (wiring) |
| `db/migrations/` | SQL migrations, applied in order on start-up (append only; never edit one that has shipped) |
| `test/` | API tests (real Postgres, fake Discord) |
| `infra/` | Bicep for all Azure resources |
| `.github/workflows/` | CI and Deploy |
