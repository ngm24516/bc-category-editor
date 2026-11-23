-- 004_importer_runs: a record of every importer run and each job's log, for the admin dashboard.

CREATE TABLE importer_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('import', 'check-updates')),
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  processed   integer NOT NULL DEFAULT 0,   -- import: jobs handled; check-updates: mods checked
  succeeded   integer NOT NULL DEFAULT 0,   -- import: jobs done; check-updates: updates queued
  failed      integer NOT NULL DEFAULT 0,
  error       text
);
CREATE INDEX importer_runs_recent ON importer_runs (started_at DESC);

-- The worker's log lines for one job (the last few thousand characters), shown on the dashboard.
ALTER TABLE import_jobs ADD COLUMN log text;
ALTER TABLE import_jobs ADD COLUMN run_id bigint REFERENCES importer_runs(id) ON DELETE SET NULL;
