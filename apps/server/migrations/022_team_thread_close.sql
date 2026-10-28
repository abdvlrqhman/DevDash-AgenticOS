-- Team: how a thread was closed and who closed it. The owner closes it as done; any role in it may decline it (not
-- ours, a duplicate, not needed, handled elsewhere) with a reason. People see it and can reopen. Both are null while open.
alter table team_threads add column closed_as text check (closed_as in ('done', 'declined', 'duplicate', 'not_needed', 'elsewhere'));
alter table team_threads add column closed_by text;
update team_threads set closed_as = 'done', closed_by = (select m.author_label from team_messages m
  where m.thread_id = team_threads.id and m.body like 'Resolved%' order by m.id desc limit 1) where status = 'resolved';
