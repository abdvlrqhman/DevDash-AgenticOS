-- Hamasa follows a session through to the end. Off per member until turned on.
alter table assistants add column follow integer not null default 0;
-- Wake turns today, against the daily cap (follow_wakes_on: the member's local date they count for).
alter table assistants add column follow_wakes integer not null default 0;
alter table assistants add column follow_wakes_on text;

create table assistant_follows (
  id integer primary key,
  user_id integer not null references users(id) on delete cascade,
  session_id text not null references claude_sessions(id) on delete cascade,
  -- What the member wants done, in Hamasa's words: the reminder carries it, so it survives clearing the chat.
  goal text not null,
  started_at integer not null,
  -- The session's last_activity_at Hamasa was last told about (or caused): newer activity while not working is due.
  seen_activity integer not null,
  -- Automatic replies since the member last wrote, and the cap.
  replies integer not null default 0,
  max_replies integer not null default 5,
  -- The last message Hamasa (or the member through Hamasa) put in the session: anything newer is a person taking over.
  last_sent_uuid text,
  -- The session's answer Hamasa last replied to, hashed: the same answer again after a reply is a loop.
  replied_hash text,
  -- on | waiting_you (reported to the member: automatic replies wait until they write)
  state text not null default 'on',
  unique (user_id, session_id)
);
create index assistant_follows_session on assistant_follows(session_id);
