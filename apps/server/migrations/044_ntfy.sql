-- Notifications through ntfy (docs.ntfy.sh) for phones whose DevDash app can't get Apple push (an iPhone app installed
-- with a sideloading service). One per member: the server (ntfy.sh unless they run their own), a random topic — on a
-- public server, knowing the topic is what lets someone read it — and an optional access token, sealed.
create table ntfy_targets (
  user_id integer primary key references users(id) on delete cascade,
  server text not null,
  topic text not null,
  token_sealed text,
  created_at integer not null default (unixepoch()),
  last_ok_at integer,
  last_error text
);
