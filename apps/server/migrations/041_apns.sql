-- Notifications for the native iPhone app while it's closed, through Apple's push service (APNs).
-- The space's APNs key, set once by an admin: token-based auth with a .p8 key (sealed with the master key).
create table apns_config (
  id integer primary key check (id = 1),
  team_id text not null,
  key_id text not null,
  key_sealed text not null,
  bundle_id text not null,
  updated_by integer references users(id) on delete set null,
  updated_at integer not null default (unixepoch()),
  -- The last thing Apple refused that an admin has to fix (a wrong key, a key for the other environment); cleared on success.
  last_error text,
  last_error_at integer
);

-- One row per iPhone app install. A token moves to whoever signs in on that phone; Apple's "gone" answers delete it.
create table apns_devices (
  id integer primary key,
  user_id integer not null references users(id) on delete cascade,
  token text not null unique,
  environment text not null check (environment in ('sandbox', 'production')),
  device text,
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch()),
  last_ok_at integer
);
create index apns_devices_user on apns_devices(user_id);
