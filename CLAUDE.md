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
- **Keep the page working without the API.** Opened as a plain file or on a static host, it must behave as a
  browser-only editor (the account area stays hidden).
- `.ini` output must stay byte-compatible with Better Containers' own writer (`writeIni` in web/index.html).

## Before opening a pull request

```
npm run lint
TEST_DATABASE_URL=postgres://bc_app:bc_app@localhost:5432/bceditor_test npm test
```

The test database must be connected as a non-superuser (`db/init-local.sql` creates `bc_app`), because
superusers bypass row-level security and the authorization tests would pass for the wrong reason.

Add tests for new endpoints, including an authorization test showing another user can't reach the data.
