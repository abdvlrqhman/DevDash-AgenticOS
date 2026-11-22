-- Upgrade pc_devices to support multiple paired devices per member (Windows PC + Android phone)
-- while preserving any already-paired device rows.
create table pc_devices_new (
  id integer primary key autoincrement,
  user_id integer not null references users(id) on delete cascade,
  name text not null,
  platform text not null default 'windows' check (platform in ('windows', 'android')),
  tailscale_ip text not null,
  port integer not null default 47821,
  token_sealed text not null,
  enabled integer not null default 1,
  allow_shell integer not null default 1,
  is_default integer not null default 0,
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch()),
  last_seen_at integer,
  unique(user_id, tailscale_ip)
);

insert into pc_devices_new (id, user_id, name, platform, tailscale_ip, port, token_sealed, enabled, allow_shell, is_default, created_at, updated_at, last_seen_at)
select id, user_id, name, 'windows', tailscale_ip, port, token_sealed, enabled, allow_shell, 1, created_at, updated_at, last_seen_at
from pc_devices;

drop table pc_devices;
alter table pc_devices_new rename to pc_devices;

create index idx_pc_devices_user on pc_devices(user_id, is_default desc, id asc);
