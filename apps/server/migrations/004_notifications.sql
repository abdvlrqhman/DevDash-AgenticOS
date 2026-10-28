-- Web Push subscriptions, one per device/browser.
create table push_subscriptions (
  id integer primary key,
  user_id integer not null references users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device text,
  created_at integer not null default (unixepoch()),
  last_ok_at integer
);

-- What each member wants to hear about (applies to all their devices).
create table notification_prefs (
  user_id integer primary key references users(id) on delete cascade,
  needs_you integer not null default 1,
  finished integer not null default 1,
  errors integer not null default 1,
  shared integer not null default 0
);

-- In-app feed of what was sent.
create table notifications (
  id integer primary key,
  user_id integer not null references users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  url text,
  created_at integer not null default (unixepoch()),
  read_at integer
);
create index notifications_user on notifications(user_id, created_at);
