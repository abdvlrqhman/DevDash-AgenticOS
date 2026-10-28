-- Team, phase 3: threads between roles, sessions and people; the lead's digest; data sources. All team_* (removable).

-- The lead (usually the CEO) gets everything that has no owner and writes the digest everyone receives.
alter table team_roles add column lead integer not null default 0;
update team_roles set lead = 1 where id in (select min(id) from team_roles where archived = 0 and upper(name) = 'CEO' group by project_id);

-- One issue, one thread: an owner role closes it, other roles are in it, people see all of them.
create table team_threads (
  id integer primary key,
  project_id integer not null references projects(id) on delete cascade,
  title text not null,
  owner_role_id integer references team_roles(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  -- set when roles went back and forth too long, or nobody owns it: waits for a person
  needs_people integer not null default 0,
  opened_by text not null,
  resolution text,
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch()),
  resolved_at integer
);
create index team_threads_project on team_threads(project_id, status, updated_at);

create table team_thread_roles (
  thread_id integer not null references team_threads(id) on delete cascade,
  role_id integer not null references team_roles(id) on delete cascade,
  -- the last message this role has seen (shown as new in its context until then)
  seen integer not null default 0,
  primary key (thread_id, role_id)
);

create table team_messages (
  id integer primary key,
  thread_id integer not null references team_threads(id) on delete cascade,
  kind text not null check (kind in ('fyi', 'question', 'request', 'alert', 'reply')),
  body text not null,
  evidence text,
  author_user_id integer references users(id) on delete set null,
  author_role_id integer references team_roles(id) on delete set null,
  author_session_id text,
  author_label text not null,
  created_at integer not null default (unixepoch())
);
create index team_messages_thread on team_messages(thread_id, id);

-- A shift woken by a thread, and what its role proposed there.
alter table team_shifts add column thread_id integer references team_threads(id) on delete set null;
alter table team_proposals add column thread_id integer references team_threads(id) on delete set null;

-- Read-only data roles can look at. `secret` (a connection string or API key) is sealed with the server's master key and
-- never reaches Claude; `config` holds the rest (base URL, file path, where the key goes).
create table team_sources (
  id integer primary key,
  project_id integer not null references projects(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('postgres', 'sqlite', 'http', 'page')),
  description text not null default '',
  config text not null default '{}',
  secret text,
  created_by integer references users(id) on delete set null,
  created_at integer not null default (unixepoch()),
  unique (project_id, name)
);
