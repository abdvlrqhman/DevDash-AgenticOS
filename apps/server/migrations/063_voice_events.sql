-- What happened in each voice conversation (states, audio sent and heard, barge-ins, recoveries, the browser's own
-- playback events), kept 24 hours for diagnosing a silent or choppy reply. Timings and names only: never text or audio.
create table voice_events (
  id integer primary key,
  call_id integer not null references voice_calls(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  at integer not null, -- ms since the epoch
  kind text not null,
  data text
);
create index voice_events_user on voice_events (user_id, at);
