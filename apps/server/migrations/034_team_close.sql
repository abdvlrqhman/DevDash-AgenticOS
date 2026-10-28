-- Team, confidence-based closing: a role can close a task or thread with a confidence score and evidence. A confident
-- close by an allowed role happens directly; otherwise it becomes a one-tap "Close? Yes/No" for people. This reuses the
-- proposals pipeline, so team_proposals.kind gains 'close'. SQLite can't alter a CHECK, so rebuild the table, copying
-- every row inside this migration's transaction. Nothing references team_proposals, so the drop/rename is safe. All team_*.
create table team_proposals_new (
  id integer primary key,
  project_id integer not null references projects(id) on delete cascade,
  role_id integer not null references team_roles(id) on delete cascade,
  kind text not null check (kind in ('task', 'code', 'goal', 'other', 'close')),
  title text not null,
  why text not null default '',
  payload text not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired', 'done')),
  reply text,
  outcome text,
  decided_by integer references users(id) on delete set null,
  decided_at integer,
  created_at integer not null default (unixepoch()),
  expires_at integer not null,
  thread_id integer references team_threads(id) on delete set null,
  awaiting text not null default 'people' check (awaiting in ('people', 'lead')),
  decided_by_role integer references team_roles(id) on delete set null
);
insert into team_proposals_new
  (id, project_id, role_id, kind, title, why, payload, status, reply, outcome, decided_by, decided_at, created_at, expires_at, thread_id, awaiting, decided_by_role)
  select id, project_id, role_id, kind, title, why, payload, status, reply, outcome, decided_by, decided_at, created_at, expires_at, thread_id, awaiting, decided_by_role
  from team_proposals;
drop table team_proposals;
alter table team_proposals_new rename to team_proposals;
create index team_proposals_status on team_proposals(status, project_id);

-- Per-project guard: closes that always need a person, whatever the confidence — spends money, touches production, or is
-- a person's decision (not just a status). A JSON object of booleans the founder can turn off per project.
alter table team_projects add column close_guard text not null default '{"money":true,"production":true,"person_decision":true}';

-- Per-role override of who may close directly: 'default' follows autonomy (an operator self-closes at confidence 8+, an
-- advisor always asks), 'always_ask' never self-closes, 'allow' may self-close even as an advisor.
alter table team_roles add column self_close text not null default 'default' check (self_close in ('default', 'always_ask', 'allow'));
