-- Dedicated per-admin agent/model settings for Shared Browser chat, independent from Autopilot.
create table browser_chat_settings (
  user_id integer primary key references users(id) on delete cascade,
  harness text not null default 'claude',
  profile text not null default 'default',
  model text not null default 'sonnet',
  effort text,
  updated_at integer not null default (unixepoch())
);
