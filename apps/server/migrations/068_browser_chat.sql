create table browser_chat_grants (
  user_id integer primary key references users(id) on delete cascade,
  admin_id integer not null references users(id) on delete cascade
);

create table browser_chat_turns (
  id integer primary key,
  user_id integer not null references users(id) on delete cascade,
  request_id text not null,
  message text not null,
  reply text,
  unique(user_id, request_id)
);
create index browser_chat_history on browser_chat_turns(user_id, id);
