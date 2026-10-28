create table users (
  id integer primary key,
  email text not null unique collate nocase,
  username text not null unique,          -- also the Linux username
  name text not null,
  role text not null check (role in ('admin', 'member')),
  password_hash text not null,
  totp_secret text not null,              -- sealed with the master key, aad "totp:user:<id>"
  totp_last_step integer not null default 0,
  created_at integer not null default (unixepoch()),
  disabled_at integer
);

create table backup_codes (
  user_id integer not null references users(id) on delete cascade,
  code_hash text not null,
  used_at integer,
  primary key (user_id, code_hash)
);

create table sessions (
  id integer primary key,
  token_hash text not null unique,
  user_id integer not null references users(id) on delete cascade,
  remember integer not null,
  expires_at integer not null,
  last_seen_at integer not null,
  created_at integer not null default (unixepoch()),
  ip text,
  user_agent text
);
create index sessions_user on sessions(user_id);

create table invites (
  id integer primary key,
  token_hash text not null unique,
  email text not null collate nocase,
  username text not null,
  role text not null check (role in ('admin', 'member')),
  totp_secret text not null,              -- sealed, aad "totp:invite:<token_hash>"; stable so a scanned QR keeps working
  expires_at integer not null,
  created_by integer references users(id),
  used_at integer,
  created_at integer not null default (unixepoch())
);

create table audit (
  id integer primary key,
  at integer not null default (unixepoch()),
  actor_id integer references users(id),
  action text not null,
  target text,
  ip text,
  meta text
);
create index audit_at on audit(at);
