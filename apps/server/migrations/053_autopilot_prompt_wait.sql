-- How long autopilot waits after a session asks something (a question, a permission, a plan) before it answers, so the
-- member can answer first if they're around. Minutes, 1 to 5.
alter table autopilot add column prompt_wait_min integer not null default 2;
