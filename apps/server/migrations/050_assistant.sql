-- Each member's personal agent (Hamasa): the agent and account it runs on, how (model, effort, permission level), what
-- it reaches beyond DevDash (their tailnet, their Google Drive), and its current conversation (an unlisted session with
-- origin_kind 'assistant'; earlier ones stay as archived sessions). Every new conversation starts with these.
create table assistants (
  user_id integer primary key references users(id) on delete cascade,
  harness text not null default 'claude',
  profile text not null default 'default',
  model text,
  effort text,
  permission_mode text not null default 'default',
  fast integer not null default 0,
  reach_tailnet integer not null default 0,
  drive integer not null default 1,
  tz text not null default 'UTC',
  session_id text references claude_sessions(id) on delete set null,
  created_at integer not null default (unixepoch())
);

-- What the personal agent does by itself: a prompt sent to it at set times (weekly slots in `tz`) or once (`run_at`).
create table assistant_schedules (
  id integer primary key,
  user_id integer not null references users(id) on delete cascade,
  title text not null,
  prompt text not null,
  slots text not null default '[]',
  run_at integer,
  tz text not null default 'UTC',
  ran text not null default '{}', -- slot key → the local date it last ran, so a slot runs once a day
  enabled integer not null default 1,
  last_run_at integer,
  created_at integer not null default (unixepoch())
);
create index assistant_schedules_user on assistant_schedules(user_id);

-- Whether a session gets the owner's Google Drive set up (on unless turned off, as for the personal agent above).
alter table claude_sessions add column drive integer not null default 1;
