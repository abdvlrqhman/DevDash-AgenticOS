-- Per-user default engine/model/effort for subagents (decoupled from the main frontier session model)
create table subagent_defaults (
  user_id integer primary key references users(id) on delete cascade,
  harness text,
  profile text not null default 'default',
  model text,
  effort text,
  permission_mode text,
  updated_at integer not null default (unixepoch())
);

-- Record which engine/model/thinking level actually ran each subagent invocation
alter table subagent_runs add column harness text;
alter table subagent_runs add column model text;
alter table subagent_runs add column effort text;
