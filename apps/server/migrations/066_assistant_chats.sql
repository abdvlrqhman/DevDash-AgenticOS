-- Hamasa keeps one conversation per agent (Claude Code, OpenCode), side by side, each with its own context, account,
-- model, effort, permission level and unread dot. assistants.harness now says which one the member talks in (the panel's
-- tab): schedules, hand-offs, follow-ups and voice go there. Reaching their tailnet and Drive, the time zone and following
-- stay in assistants, for both chats.
create table assistant_chats (
  user_id integer not null references users(id) on delete cascade,
  harness text not null,
  profile text not null default 'default',
  model text,
  effort text,
  permission_mode text not null default 'default',
  fast integer not null default 0,
  session_id text references claude_sessions(id) on delete set null,
  unread integer not null default 0,
  primary key (user_id, harness)
);

-- Each member's chat so far becomes the one of its agent. assistants' own profile, model, effort, permission_mode, fast,
-- session_id and unread are no longer read; they stay so an older release still runs on this database.
insert into assistant_chats (user_id, harness, profile, model, effort, permission_mode, fast, session_id, unread)
  select user_id, harness, profile, model, effort, permission_mode, fast, session_id, unread from assistants;
