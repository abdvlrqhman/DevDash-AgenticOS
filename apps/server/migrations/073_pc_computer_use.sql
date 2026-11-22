-- Per-member Tailscale-only PC Computer Use device pairing and action audit log.
-- The PC agent binds exclusively to its Tailscale IP and every call is gated on live Tailscale peer status.
create table pc_devices (
  id integer primary key autoincrement,
  user_id integer not null unique references users(id) on delete cascade,
  name text not null,
  tailscale_ip text not null,
  port integer not null default 47821,
  token_sealed text not null,
  enabled integer not null default 1,
  allow_shell integer not null default 1,
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch()),
  last_seen_at integer
);

create table pc_audit_log (
  id integer primary key autoincrement,
  user_id integer not null references users(id) on delete cascade,
  device_id integer references pc_devices(id) on delete set null,
  source text not null default 'mcp',
  action text not null,
  summary text not null default '',
  ok integer not null default 1,
  duration_ms integer not null default 0,
  created_at integer not null default (unixepoch())
);

create index idx_pc_audit_user_created on pc_audit_log(user_id, created_at desc, id desc);
