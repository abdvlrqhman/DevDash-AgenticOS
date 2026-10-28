-- Claude sessions. The id is Claude Code's own session id, so the transcript lives in the owner's
-- <profile config>/projects/<cwd>/<id>.jsonl and both Chat (SDK) and CLI mode resume the same conversation.
create table claude_sessions (
  id text primary key,
  owner_id integer not null references users(id) on delete cascade,
  profile text not null default 'default',
  title text not null,
  cwd text not null,
  mode text not null default 'chat' check (mode in ('chat', 'cli')),
  status text not null default 'idle' check (status in ('working', 'waiting', 'idle', 'stopped', 'error')),
  status_detail text,
  model text,
  effort text,
  permission_mode text not null default 'bypassPermissions',
  started integer not null default 0,
  shared integer not null default 0,
  shared_can_send integer not null default 0,
  archived integer not null default 0,
  created_at integer not null default (unixepoch()),
  last_activity_at integer not null default (unixepoch())
);
create index claude_sessions_owner on claude_sessions(owner_id, archived, last_activity_at);

-- Who typed each message in a shared session (the transcript itself only knows "user").
create table claude_message_senders (
  session_id text not null references claude_sessions(id) on delete cascade,
  message_uuid text not null,
  user_id integer not null references users(id) on delete cascade,
  primary key (session_id, message_uuid)
);

-- Per-member defaults for new sessions.
create table claude_defaults (
  user_id integer primary key references users(id) on delete cascade,
  profile text not null default 'default',
  model text,
  effort text,
  permission_mode text not null default 'bypassPermissions',
  open_in text not null default 'chat' check (open_in in ('chat', 'cli'))
);
