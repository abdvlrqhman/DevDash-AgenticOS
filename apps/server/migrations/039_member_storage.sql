-- Members' own cloud storage (Google Drive for now), so big outputs like videos leave the server's disk.
-- The Google OAuth app an admin registers once; every member connects their own Drive with it.
create table storage_apps (
  provider text primary key check (provider in ('gdrive')),
  client_id text not null,
  client_secret_sealed text not null,
  updated_by integer references users(id) on delete set null,
  updated_at integer not null default (unixepoch())
);

-- One connected storage per member. The Google refresh token never leaves the server: the member's rclone gets an
-- opaque handle that the server's local token endpoint trades for short-lived access tokens. Disconnecting kills it.
create table member_storage (
  user_id integer primary key references users(id) on delete cascade,
  provider text not null check (provider in ('gdrive')),
  account_sub text not null,
  account_email text not null,
  folder_id text not null,
  refresh_token_sealed text not null,
  handle_hash text not null unique,
  handle_sealed text not null,
  -- Why it stopped working (Google revoked access, the app changed); null while it works.
  broken text,
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch())
);
