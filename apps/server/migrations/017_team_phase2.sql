-- Team, phase 2: roles that work on their own (schedules, triggers, approvals, goals, limits). All team_* (removable).

-- A paused team runs nothing on its own. `tz` is where schedules are read (set from the browser of whoever edits them).
-- `activity_seen`: the last activity row the triggers looked at.
alter table team_projects add column paused integer not null default 0;
alter table team_projects add column tz text not null default 'UTC';
alter table team_projects add column activity_seen integer not null default 0;
update team_projects set activity_seen = coalesce((select max(id) from activity), 0);

-- advisor: only suggests; operator: does safe things itself (tasks, notes) and proposes the rest.
alter table team_roles add column autonomy text not null default 'operator';
-- JSON list of proposal kinds it may carry out without asking ("code", "goal").
alter table team_roles add column auto_approve text not null default '[]';
-- JSON [{"days":[1,2,3,4,5],"at":"09:00"}]; days 0 = Sunday. Read in the project's tz.
alter table team_roles add column schedule text not null default '[]';
-- JSON list: "work" (a Claude session in the project finished something), "task_done", "task_created".
alter table team_roles add column triggers text not null default '[]';
-- JSON {"<slot>":"YYYY-MM-DD"}: which scheduled slots already ran on which local day.
alter table team_roles add column schedule_state text not null default '{}';
alter table team_roles add column paused integer not null default 0;
-- Limits for shifts it starts on its own: how many a day, and the API-value of a month's usage in USD (null = none).
alter table team_roles add column daily_limit integer not null default 6;
alter table team_roles add column monthly_budget real;
alter table team_roles add column last_triggered integer not null default 0;

alter table team_shifts add column cost_usd real not null default 0;

-- What a role wants to do that needs a person: a coding job, a new goal, tasks (for advisors), or something for people.
create table team_proposals (
  id integer primary key,
  project_id integer not null references projects(id) on delete cascade,
  role_id integer not null references team_roles(id) on delete cascade,
  kind text not null check (kind in ('task', 'code', 'goal', 'other')),
  title text not null,
  why text not null default '',
  payload text not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired', 'done')),
  reply text,
  outcome text,
  decided_by integer references users(id) on delete set null,
  decided_at integer,
  created_at integer not null default (unixepoch()),
  expires_at integer not null
);
create index team_proposals_status on team_proposals(status, project_id);

create table team_goals (
  id integer primary key,
  project_id integer not null references projects(id) on delete cascade,
  title text not null,
  measure text not null default '',
  due text,
  status text not null default 'active' check (status in ('active', 'done', 'dropped')),
  progress integer not null default 0,
  note text,
  owner_role_id integer references team_roles(id) on delete set null,
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch())
);
create index team_goals_project on team_goals(project_id, status);
