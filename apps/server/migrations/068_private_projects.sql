-- Who can see a project: the whole team ('team'), or, private, only its creator and the members it's shared with.
-- Existing projects stay on the team; making one private is its creator's choice (apps/server/src/modules/projects/access.ts).
alter table projects add column visibility text not null default 'team' check (visibility in ('team', 'private'));
create table project_members (
  project_id integer not null references projects(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  primary key (project_id, user_id)
);
