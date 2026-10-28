-- Per-session switches the owner sets in the session view.
alter table claude_sessions add column fast_mode integer not null default 0;
alter table claude_sessions add column remote_control integer not null default 0;
-- The last /context reading ({"percent","tokens","max"}), so the chip shows before the next turn ends.
alter table claude_sessions add column context_json text;

-- Teammates the owner let in after they asked to join a shared session: they can send messages too.
create table claude_session_writers (
  session_id text not null references claude_sessions(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  primary key (session_id, user_id)
);

-- Comments people leave on a session. They are for the team, never sent to Claude.
create table claude_session_comments (
  id integer primary key,
  session_id text not null references claude_sessions(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  body text not null,
  created_at integer not null default (unixepoch())
);
create index claude_session_comments_session on claude_session_comments(session_id, id);
