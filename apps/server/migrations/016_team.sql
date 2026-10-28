-- Team: AI team members (roles) for a project. Every table is team_*, and no core table points at them, so the whole
-- feature can be removed by dropping these.

-- Team switched on for a project, and whose account (Linux user and Claude plan) its roles run as.
create table team_projects (
  project_id integer primary key references projects(id) on delete cascade,
  runs_as integer not null references users(id),
  enabled_at integer not null default (unixepoch())
);

-- What the project is, for whom, and where it stands. Every role reads it first.
create table team_briefs (
  project_id integer primary key references projects(id) on delete cascade,
  body text not null default '',
  updated_by integer references users(id) on delete set null,
  updated_at integer not null default (unixepoch())
);

-- Decisions people or roles made, so nobody re-argues them.
create table team_decisions (
  id integer primary key,
  project_id integer not null references projects(id) on delete cascade,
  body text not null,
  user_id integer references users(id) on delete set null,
  role_id integer references team_roles(id) on delete set null,
  created_at integer not null default (unixepoch())
);
create index team_decisions_project on team_decisions(project_id, id);

create table team_roles (
  id integer primary key,
  project_id integer not null references projects(id) on delete cascade,
  name text not null,
  summary text not null default '',
  instructions text not null default '',
  model text,
  chat_session_id text,
  created_by integer references users(id) on delete set null,
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch()),
  archived integer not null default 0
);
create index team_roles_project on team_roles(project_id, archived);

-- One role's own memory: facts, lessons, what people said, what was rejected and why.
create table team_notebook (
  id integer primary key,
  role_id integer not null references team_roles(id) on delete cascade,
  body text not null,
  source text not null default 'role' check (source in ('role', 'person')),
  user_id integer references users(id) on delete set null,
  created_at integer not null default (unixepoch())
);
create index team_notebook_role on team_notebook(role_id, id);

-- Each time a role works on its own.
create table team_shifts (
  id integer primary key,
  role_id integer not null references team_roles(id) on delete cascade,
  session_id text,
  trigger text not null default 'manual',
  status text not null default 'running' check (status in ('running', 'done', 'error')),
  report text,
  started_at integer not null default (unixepoch()),
  ended_at integer
);
create index team_shifts_role on team_shifts(role_id, id);

-- What happened in the project that the activity feed doesn't say: short summaries of Claude sessions' work.
create table team_journal (
  id integer primary key,
  project_id integer not null references projects(id) on delete cascade,
  session_id text,
  user_id integer references users(id) on delete set null,
  body text not null,
  -- how many transcript messages this and earlier summaries of the session cover; the next one starts there
  upto integer not null default 0,
  created_at integer not null default (unixepoch())
);
create index team_journal_project on team_journal(project_id, id);
create index team_journal_session on team_journal(session_id, id);
