-- Phase 4: projects (shared git checkouts in /srv/devdash/projects/<slug>), tasks, notes, activity, search.

create table projects (
  id integer primary key,
  slug text not null unique,               -- folder name and task prefix: app-mobile #18
  name text not null,
  repo_url text,                           -- null for a project that only lives here
  default_branch text not null default 'main',
  created_by integer not null references users(id),
  created_at integer not null default (unixepoch()),
  fetched_at integer,
  fetch_error text,
  next_task integer not null default 1,
  archived integer not null default 0
);

-- Last commit seen per branch, so each scan only reads new commits. The first scan only records them.
create table project_refs (
  project_id integer not null references projects(id) on delete cascade,
  ref text not null,
  sha text not null,
  primary key (project_id, ref)
);

create table tasks (
  id integer primary key,
  project_id integer not null references projects(id) on delete cascade,
  number integer not null,
  title text not null,
  body text not null default '',
  status text not null default 'todo' check (status in ('backlog', 'todo', 'in_progress', 'review', 'done')),
  priority text not null default 'none' check (priority in ('none', 'low', 'medium', 'high', 'urgent')),
  due_date text,                           -- YYYY-MM-DD
  assignee_id integer references users(id) on delete set null,
  sort real not null default 0,            -- order within its column
  created_by integer not null references users(id),
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch()),
  closed_at integer,
  unique (project_id, number)
);
create index tasks_status on tasks(status, sort);
create index tasks_assignee on tasks(assignee_id, status);

create table task_comments (
  id integer primary key,
  task_id integer not null references tasks(id) on delete cascade,
  user_id integer not null references users(id),
  via_claude integer not null default 0,
  body text not null,
  created_at integer not null default (unixepoch())
);

-- Commits that mention a task (fixes #N) and Claude sessions working on it.
create table task_links (
  task_id integer not null references tasks(id) on delete cascade,
  kind text not null check (kind in ('commit', 'session')),
  ref text not null,                       -- commit sha or session id
  title text not null default '',
  meta text not null default '',           -- commit: branch it was found on
  created_at integer not null default (unixepoch()),
  primary key (task_id, kind, ref)
);

create table notes (
  id integer primary key,
  project_id integer references projects(id) on delete set null,
  title text not null,
  body text not null default '',
  pinned integer not null default 0,
  private integer not null default 0,      -- only its author sees it
  created_by integer not null references users(id),
  updated_by integer not null references users(id),
  via_claude integer not null default 0,
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch())
);

create table activity (
  id integer primary key,
  project_id integer references projects(id) on delete cascade,
  user_id integer references users(id) on delete set null,
  via_claude integer not null default 0,
  kind text not null,                      -- task.created, task.status, task.comment, task.closed_by_commit, note.saved, project.created
  summary text not null,
  url text,
  created_at integer not null default (unixepoch())
);
create index activity_recent on activity(created_at);

-- Everything searchable from ⌘K. Kept in step by the services that own the rows.
create virtual table search using fts5(kind unindexed, ref unindexed, title, body, tokenize = 'unicode61 remove_diacritics 2');

alter table claude_sessions add column project_id integer references projects(id) on delete set null;
alter table claude_sessions add column worktree text;
