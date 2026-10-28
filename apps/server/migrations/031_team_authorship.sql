-- Team authorship: when a team role creates a task, comment, note or activity entry — through a Claude session that runs
-- as the member the team runs as — remember which role did it, so it shows as the role ("CEO · AI team"), not the paying
-- account. A plain text label, never a foreign key, so core tables stay unaware of team_* and
-- dropping Team leaves these columns harmlessly unused. Backfill of existing rows is a separate, reversible migration.
alter table tasks add column via_role text;
alter table task_comments add column via_role text;
alter table notes add column via_role text;
alter table activity add column via_role text;
