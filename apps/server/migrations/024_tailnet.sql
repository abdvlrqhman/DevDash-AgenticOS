-- Per-user tailnets: each member can bring up their own userspace Tailscale node, running
-- inside their agent as them, logged into their own Tailscale account. One row per member. The auth key is a secret,
-- stored SEALED with the master key (AES-256-GCM, AAD "tailnet:<userId>"); it is only ever decrypted server-side to
-- hand to the member's agent, and never sent to the browser.
create table tailnet_nodes (
  user_id integer primary key references users(id) on delete cascade,
  hostname text not null,
  socks_port integer,
  http_port integer,
  -- the member's reusable auth key, sealed; null once they disconnect with "forget key"
  auth_key_sealed text,
  connected integer not null default 0,
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch())
);
