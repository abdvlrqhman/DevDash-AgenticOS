-- Autopilot: a member lets their own sessions make routine decisions for them by their rules,
-- and a supervisor keeps their stalled sessions moving. Off for everyone until they turn it on.
create table autopilot (
  user_id integer primary key references users(id) on delete cascade,
  enabled integer not null default 0,
  rules text, -- null: the default rules
  tz text not null default 'Europe/Berlin',
  ping_at text not null default '09:00', -- the morning ping, local time in tz
  quiet_min integer not null default 20, -- no supervisor message within this long of the last activity
  night_cap integer not null default 20, -- supervisor messages between two morning pings
  max_nudges integer not null default 3, -- per session and goal
  seen_at integer not null default 0, -- the member last opened the Autopilot page
  pinged_on text, -- local date of the last morning ping check
  paused_until integer, -- the Claude usage limit was hit: the supervisor waits until then
  updated_at integer not null default (unixepoch())
);

-- Everything decided or done on autopilot: sessions' decisions (green, yellow), the supervisor's actions, and toggles.
create table autopilot_log (
  id integer primary key,
  user_id integer not null references users(id) on delete cascade,
  at integer not null default (unixepoch()),
  tier text not null check (tier in ('green', 'yellow', 'red', 'action', 'system')),
  source text not null default 'session' check (source in ('session', 'supervisor', 'system')),
  project text,
  session_id text,
  what text not null,
  why text,
  message text -- what the supervisor sent, word for word
);
create index autopilot_log_user on autopilot_log(user_id, id);

-- "Needs you": sessions stopped on a red question, or stuck after the nudge limit. Resolved when the member writes in
-- the session, or dismisses it.
create table autopilot_inbox (
  id integer primary key,
  user_id integer not null references users(id) on delete cascade,
  session_id text,
  thread_id integer,
  kind text not null check (kind in ('red', 'stuck', 'permission', 'thread')),
  title text not null,
  detail text,
  created_at integer not null default (unixepoch()),
  resolved_at integer
);
create index autopilot_inbox_open on autopilot_inbox(user_id, resolved_at);

-- The supervisor's memory per session: which goal (the member's own last message) it nudged how often, the last error
-- it saw, and the activity it last judged as nothing to do.
create table autopilot_sessions (
  session_id text primary key references claude_sessions(id) on delete cascade,
  goal text,
  nudges integer not null default 0,
  last_error text,
  checked_activity integer, -- last_activity_at when it was last judged done or not worth a message
  rules_sent text, -- the rules version this session was last given ('off' after it was told autopilot is off)
  relayed_message integer -- the last team thread message passed on to it
);

-- Messages the supervisor sent as the member: they never count as the member's own goal.
create table autopilot_sent (
  uuid text primary key,
  session_id text not null,
  at integer not null default (unixepoch())
);
