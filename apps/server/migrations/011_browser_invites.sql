-- Invite links to the shared browser for people without a DevDash account: watch-only unless allowed to take control.
create table browser_invites (
  id integer primary key,
  token_hash text not null unique,
  token_sealed text not null,              -- so its creator can copy the link again
  label text not null,                     -- the name guests appear under
  can_control integer not null default 0,
  expires_at integer not null,
  created_by integer not null references users(id) on delete cascade,
  created_at integer not null default (unixepoch()),
  revoked_at integer
);
