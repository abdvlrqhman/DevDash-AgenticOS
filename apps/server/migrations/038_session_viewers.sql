-- Sharing a session with chosen people instead of the whole team. A session is visible to its owner, to everyone while
-- `shared` is on, or to the members listed here. Whether someone may also send messages stays in claude_session_writers.
create table claude_session_viewers (
  session_id text not null references claude_sessions(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  primary key (session_id, user_id)
);
create index claude_session_viewers_user on claude_session_viewers(user_id);
