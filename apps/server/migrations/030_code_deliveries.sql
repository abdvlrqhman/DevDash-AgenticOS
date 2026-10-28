-- "Ready to review": when a role's approved *code* proposal finishes with commits on its branch (claude/service.ts
-- execute(), origin_kind='proposal'), the work becomes a delivery the founder ships in one tap — a PR (CI runs the
-- tests) or, for a non-GitHub project, a local merge. Owned by the reviews module; the team module detects "done with
-- commits" (it has the proposal context) and records it. One row per session.
create table code_deliveries (
  id integer primary key,
  project_id integer not null references projects(id) on delete cascade,
  session_id text not null unique references claude_sessions(id) on delete cascade,
  role text not null,                      -- the role whose proposal this was (origin_role)
  title text not null,
  branch text not null,                    -- the session's worktree branch, e.g. dd/ab12cd34
  base_branch text not null,               -- what it merges back into (the project's default branch)
  commits integer not null default 0,
  files integer not null default 0,
  insertions integer not null default 0,
  deletions integer not null default 0,
  status text not null default 'ready' check (status in ('ready', 'opened', 'merged', 'dismissed')),
  pr_url text,
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch())
);
create index code_deliveries_project on code_deliveries (project_id, status);
