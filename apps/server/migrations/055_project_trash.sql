-- Deleting a project is a soft delete with seven days to restore it: its folder moves to /srv/devdash/trash and the row
-- stays (hidden, its short name still taken) until it's restored or purged. `deleted_archived` remembers whether it was
-- archived before, since deleting also archives it (everything that skips archived projects then skips it too).
alter table projects add column deleted_at integer;
alter table projects add column deleted_by integer references users(id);
alter table projects add column deleted_archived integer not null default 0;
