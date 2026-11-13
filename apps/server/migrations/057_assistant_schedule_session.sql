-- Each schedule of the personal agent runs in a conversation of its own, not the one the member is chatting in. Made on
-- its first run; made again when it was archived or the member has picked another agent since.
alter table assistant_schedules add column session_id text;
