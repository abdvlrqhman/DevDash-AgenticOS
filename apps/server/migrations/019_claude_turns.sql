-- What each Chat answer took: time, tokens and what it would cost on the API. Claude Code's transcript doesn't keep
-- this, so it is saved here when the answer ends and shown under the answer for good (also after a reload).
create table claude_turns (
  id integer primary key,
  session_id text not null references claude_sessions(id) on delete cascade,
  -- the result's own id, and the message it follows (the answer's last message), to place it in the transcript
  result_uuid text not null unique,
  after_uuid text,
  prompt_uuid text,
  ok integer not null,
  duration_ms integer not null default 0,
  cost_usd real not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  num_turns integer not null default 0,
  model text,
  created_at integer not null default (unixepoch())
);
create index claude_turns_session on claude_turns(session_id, id);
