-- Autopilot and the AI team: per project, whether autopilot answers for the member what the project's role agents
-- ask people (proposals on /approvals, and questions in threads). Off for every project until the member turns it on.
create table autopilot_team (
  user_id integer not null references users(id) on delete cascade,
  project_id integer not null references projects(id) on delete cascade,
  primary key (user_id, project_id)
);
-- What autopilot already handled ('proposal:<id>', 'ask:<thread>:<last message>'), so each is handled once.
create table autopilot_team_done (
  user_id integer not null references users(id) on delete cascade,
  item text not null,
  at integer not null default (unixepoch()),
  primary key (user_id, item)
);
-- A "Needs you" item can point anywhere (an approval, a thread), not only at a session.
alter table autopilot_inbox add column url text;
