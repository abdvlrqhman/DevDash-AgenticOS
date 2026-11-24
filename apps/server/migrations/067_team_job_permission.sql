-- The permission level a team role's coding jobs start with (an approved "code" proposal's session). Null: the
-- approving member's own default.
alter table team_roles add column job_permission text;
