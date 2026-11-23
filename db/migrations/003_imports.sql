-- 003_imports: importing Workshop mods, and a record of who asked for what.
--
-- import_requests  one per thing a signed-in user asked to import (a mod or a collection). This is the
--                  audit trail ("who added what") and what the daily limits count. User data: RLS.
-- import_request_items  the Workshop items in a request (one for a mod, many for a collection), each
--                  pointing at the job that imports it, or straight at the mod when it was already there.
-- import_jobs      the work queue the importer job drains. Shared and written only by the server and the
--                  importer; at most one open job per Workshop item, so two people asking at once share it.

ALTER TABLE mod_versions ADD COLUMN requested_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE mod_versions ADD COLUMN source_title text;

CREATE TABLE import_jobs (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workshop_id       text NOT NULL CHECK (workshop_id ~ '^[0-9]{1,20}$'),
  reason            text NOT NULL CHECK (reason IN ('request', 'update')),
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  requested_by      uuid REFERENCES users(id) ON DELETE SET NULL,  -- NULL for the hourly update check
  source_updated_at timestamptz,                                   -- Workshop "last updated" when queued
  title             text,
  mod_id            uuid REFERENCES mods(id) ON DELETE SET NULL,
  version_id        uuid REFERENCES mod_versions(id) ON DELETE SET NULL,
  error             text,
  attempts          integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz
);
CREATE UNIQUE INDEX import_jobs_one_open ON import_jobs (workshop_id) WHERE status IN ('queued', 'running');
CREATE INDEX import_jobs_queue ON import_jobs (created_at) WHERE status = 'queued';

CREATE TABLE import_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('mod', 'collection')),
  workshop_id text NOT NULL CHECK (workshop_id ~ '^[0-9]{1,20}$'),
  title       text,
  new_jobs    integer NOT NULL DEFAULT 0,   -- items this request had to download (what the daily limit counts)
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX import_requests_user_day ON import_requests (user_id, created_at DESC);

CREATE TABLE import_request_items (
  request_id  uuid NOT NULL,
  user_id     uuid NOT NULL,
  workshop_id text NOT NULL,
  title       text,
  job_id      bigint REFERENCES import_jobs(id) ON DELETE SET NULL,
  mod_id      uuid REFERENCES mods(id) ON DELETE SET NULL,   -- set when the mod was already in the catalog
  skipped     text,                                          -- why it wasn't imported (not a PZ mod, too big…)
  PRIMARY KEY (request_id, workshop_id),
  FOREIGN KEY (request_id, user_id) REFERENCES import_requests(id, user_id) ON DELETE CASCADE
);

ALTER TABLE import_requests      ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_requests      FORCE  ROW LEVEL SECURITY;
ALTER TABLE import_request_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_request_items FORCE  ROW LEVEL SECURITY;
CREATE POLICY own_import_requests ON import_requests
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY own_import_request_items ON import_request_items
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
