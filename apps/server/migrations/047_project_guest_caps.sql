-- Each member's own default, per project, for what teammates' requests may use of theirs in their sessions there
-- (agent guest.ts). A session follows it unless its own Share dialog set something else (guest_caps_custom).
create table project_guest_caps (
  user_id integer not null references users(id) on delete cascade,
  project_id integer not null references projects(id) on delete cascade,
  caps text not null default '',
  primary key (user_id, project_id)
);
alter table claude_sessions add column guest_caps_custom integer not null default 0;
-- Sessions already set by hand keep what they have; "commands" is no longer a choice (commands run for teammates).
update claude_sessions set guest_caps_custom = 1 where guest_caps != '';
update claude_sessions set guest_caps = trim(replace(replace(',' || guest_caps || ',', ',commands,', ','), ',,', ','), ',');
