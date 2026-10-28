-- Zero-knowledge vault: the server stores only public keys, wrapped keys and ciphertext. All crypto runs in browsers.

-- Each member's vault identity: a P-256 key pair whose private half is encrypted with a key derived from their
-- vault password (PBKDF2-SHA256 in the browser). The server never sees the password or any key in the clear.
create table vault_users (
  user_id integer primary key references users(id) on delete cascade,
  salt text not null,
  iterations integer not null,
  public_key text not null,                -- SPKI, base64
  private_key text not null,               -- JSON {iv, data}: PKCS#8 encrypted with the password key
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch())
);

create table vaults (
  id integer primary key,
  kind text not null check (kind in ('personal', 'team')),
  owner_id integer references users(id) on delete cascade, -- personal vaults only
  key_version integer not null default 1,
  needs_rotation integer not null default 0, -- someone lost access: the next member to unlock replaces the key
  created_at integer not null default (unixepoch())
);
create unique index vaults_personal on vaults(owner_id) where kind = 'personal';
create unique index vaults_team on vaults(kind) where kind = 'team';

-- A vault's key, wrapped for one member (ECDH with an ephemeral key + HKDF + AES-GCM).
create table vault_keys (
  vault_id integer not null references vaults(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  key_version integer not null,
  wrapped text not null,                   -- JSON {epk, iv, data}
  primary key (vault_id, user_id)
);

create table vault_items (
  id text primary key,                     -- uuid chosen by the browser (part of the encryption's associated data)
  vault_id integer not null references vaults(id) on delete cascade,
  key_version integer not null,
  iv text not null,
  data text not null,                      -- AES-GCM ciphertext of the item JSON
  updated_by integer references users(id) on delete set null,
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch())
);
create index vault_items_vault on vault_items(vault_id);
