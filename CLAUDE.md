# Working in this repo

Better Containers Category Editor: static editor page (`web/`) + Node/Express API (`server/`) with Discord
sign-in and Postgres, deployed as one container to Azure Container Apps. See README.md for the architecture.

## Rules

- **Every query on user data goes through `withUser(pool, req.user.id, fn)`** (server/db.js). Row-level
  security depends on it. Never take a user id from the request body, query string or URL.
- **Schema changes are new files** in `db/migrations/` (`NNN_description.sql`). Never edit a migration that
  is on `main`. New user-data tables get `user_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, and a policy on
  `app_user_id()`, like 001_init.sql.
- **No secrets in the repo.** Config comes from environment variables (server/config.js). Secrets live in
  Container Apps secrets and are passed to Bicep via environment variables.
- **Keep the API boring:** JSON in, JSON out, validate input (see `cleanBody` in server/sets.js), return
  `{ error, message }` with a proper status code, never a stack trace.
- **The item catalog is shared and read-only for users.** Base game + imported Workshop mods live in `mods`,
  `mod_versions`, `catalog_items`, `icon_sheets`. A version is never changed after it's written (the API caches
  it forever); an update is a new version. Setups choose mods in `set_mods` (user data, RLS).
- **Outbound calls to addresses users or admins type in** (marketplace APIs) go through `getJsonSafely`
  (server/safe-fetch.js) or `get_json` (importer/market.py): https only, public IPs only, pinned to the checked IP,
  no redirects, size and time limits. Only admins can add a marketplace.
- **Importer code (`importer/pzcatalog`) only reads files.** Never execute, `require` or `eval` anything from a mod.
- **Imports need a signed-in user and are recorded** (`import_requests`, RLS) against that user; jobs carry
  `requested_by`; the first import of a mod sets `mods.created_by`. The API only queues `import_jobs`; only the
  worker downloads. Daily limits live in `LIMITS` (server/imports.js).
- Signed out, the editor still works with edits kept in the browser; it needs the API for the item list.
- **Styles live in `web/src/app.css`** (Tailwind v4, every rule through `@apply` or Tailwind's theme variables).
  `web/app.css` is generated: never edit or commit it. Tailwind doesn't scan the page (`source(none)`), so a
  class name in the HTML never turns into a utility by accident.
- `.ini` output must stay byte-compatible with Better Containers' own writer (`writeIni` in web/index.html).

## Before opening a pull request

```
npm run lint
python3 -m unittest discover -s importer/tests
TEST_DATABASE_URL=postgres://bc_app:bc_app@localhost:5432/bceditor_test npm test
TEST_DATABASE_URL=postgres://bc_app:bc_app@localhost:5432/bceditor_test python3 -m unittest discover -s importer/tests
```

The test database must be connected as a non-superuser (`db/init-local.sql` creates `bc_app`), because
superusers bypass row-level security and the authorization tests would pass for the wrong reason.

Add tests for new endpoints, including an authorization test showing another user can't reach the data.
