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
- **Importer code (`importer/pzcatalog`) only reads files.** Never execute, `require` or `eval` anything from a mod.
- Signed out, the editor still works with edits kept in the browser; it needs the API for the item list.
- `.ini` output must stay byte-compatible with Better Containers' own writer (`writeIni` in web/index.html).

## Before opening a pull request

```
npm run lint
python3 -m unittest discover -s importer/tests
TEST_DATABASE_URL=postgres://bc_app:bc_app@localhost:5432/bceditor_test npm test
```

The test database must be connected as a non-superuser (`db/init-local.sql` creates `bc_app`), because
superusers bypass row-level security and the authorization tests would pass for the wrong reason.

Add tests for new endpoints, including an authorization test showing another user can't reach the data.
