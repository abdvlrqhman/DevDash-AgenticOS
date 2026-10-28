-- Share links: a frozen copy of a file (or build artifact) under <data>/shares/<id>, downloadable without an account.
create table shares (
  id integer primary key,
  token_hash text not null unique,         -- sha256 of the link token, for lookups
  token_sealed text not null,              -- the token, sealed with the master key, so its creator can copy the link again
  name text not null,
  size integer not null default 0,
  source text not null,                    -- where it came from (a path, or "build <target> #<run>")
  password_hash text,
  expires_at integer,
  max_downloads integer,
  downloads integer not null default 0,
  created_by integer not null references users(id) on delete cascade,
  created_at integer not null default (unixepoch()),
  revoked_at integer
);
