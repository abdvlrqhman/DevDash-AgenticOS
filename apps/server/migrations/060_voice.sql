-- Voice mode for each member's personal agent: their own providers, keys, voice and monthly cap.
create table voice_settings (
  user_id integer primary key references users(id) on delete cascade,
  enabled integer not null default 0,
  stt text not null default 'soniox',
  tts text not null default 'fish',
  voices text not null default '{}',      -- the chosen voice per TTS provider (and per language), JSON: {"fish": {"id", "name"}, "fish:ar": …}
  voice_per_language integer not null default 0, -- a voice of its own for each language they speak
  languages text not null default '["en"]', -- what they speak, as hints for recognition, JSON
  monthly_cap_usd real,                   -- null: no cap
  updated_at integer not null default (unixepoch())
);

-- Their API keys, sealed with the server's master key (AES-256-GCM, bound to the member and provider). Only the last
-- four characters are ever shown again.
create table voice_keys (
  user_id integer not null references users(id) on delete cascade,
  provider text not null,
  sealed text not null,
  hint text not null,
  updated_at integer not null default (unixepoch()),
  primary key (user_id, provider)
);

-- One row per voice conversation: what it used and what it cost at the prices of the day.
create table voice_calls (
  id integer primary key,
  user_id integer not null references users(id) on delete cascade,
  stt text not null,
  tts text not null,
  started_at integer not null default (unixepoch()),
  ended_at integer,
  stt_seconds real not null default 0,
  tts_chars integer not null default 0,
  cost_usd real not null default 0
);
create index voice_calls_user on voice_calls (user_id, started_at);
