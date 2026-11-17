-- Whether the agent wrote in the member's chat since they last looked: a dot on its launchers until they do.
alter table assistants add column unread integer not null default 0;

-- Schedules' own conversations say so: their runs hand over to the member's chat instead of notifying them.
update claude_sessions set origin_role = 'schedule' where id in (select session_id from assistant_schedules where session_id is not null);
