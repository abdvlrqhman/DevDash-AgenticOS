-- Updating DevDash itself to a newer commit of its GitHub repository: asked for by a member or their Claude session,
-- run by an admin (Server page). The server deploys itself through the root helper (deploy/self-deploy.sh).
create table deploys (
  id integer primary key,
  sha text not null,
  -- requested (waiting for an admin), declined, running, done, failed
  status text not null,
  note text,
  requested_by integer references users(id) on delete set null,
  session_id text,
  decided_by integer references users(id) on delete set null,
  -- the end of the deploy's output when it failed
  log text,
  created_at integer not null default (unixepoch()),
  started_at integer,
  finished_at integer
);
create index deploys_status on deploys(status, id);
