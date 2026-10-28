-- One-tap builds: a GitHub Actions workflow (with workflow_dispatch), the branch to build and its inputs.
create table build_targets (
  id integer primary key,
  project_id integer not null references projects(id) on delete cascade,
  name text not null,
  workflow text not null,                  -- file name in .github/workflows, e.g. release.yml
  ref text not null,
  inputs text not null default '{}',       -- JSON object of workflow inputs
  created_by integer not null references users(id),
  created_at integer not null default (unixepoch())
);
