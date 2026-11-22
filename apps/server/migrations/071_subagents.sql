-- Member-owned custom subagent definitions (usable by Hamasa, normal sessions, or manual runs)
create table custom_subagents (
  id integer primary key autoincrement,
  user_id integer not null references users(id) on delete cascade,
  slug text not null,
  name text not null,
  description text not null default '',
  instructions text not null,
  icon text not null default 'bot',
  color text not null default 'blue',
  scope text not null default 'both' check (scope in ('both', 'hamasa', 'sessions')),
  harness text,
  profile text not null default 'default',
  model text,
  effort text,
  permission_mode text,
  default_project text,
  default_cwd text,
  enabled integer not null default 1,
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch()),
  unique(user_id, slug)
);

-- Persistent run history and live progress for every custom subagent invocation
create table subagent_runs (
  id integer primary key autoincrement,
  user_id integer not null references users(id) on delete cascade,
  subagent_id integer references custom_subagents(id) on delete set null,
  subagent_slug text not null,
  subagent_name text not null,
  subagent_icon text not null default 'bot',
  subagent_color text not null default 'blue',
  session_id text references claude_sessions(id) on delete set null,
  caller_kind text not null default 'manual' check (caller_kind in ('manual', 'hamasa', 'session')),
  caller_session_id text,
  caller_label text,
  task text not null,
  project_slug text,
  cwd text,
  status text not null default 'running' check (status in ('running', 'waiting', 'completed', 'failed', 'stopped')),
  activity text not null default 'Starting…',
  steps_json text not null default '[]',
  result text,
  error text,
  cost_usd real,
  started_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch()),
  finished_at integer
);

create index idx_custom_subagents_user on custom_subagents(user_id, enabled, name);
create index idx_subagent_runs_user_started on subagent_runs(user_id, started_at desc, id desc);
create index idx_subagent_runs_subagent on subagent_runs(subagent_id, started_at desc, id desc);
create index idx_subagent_runs_session on subagent_runs(session_id);
