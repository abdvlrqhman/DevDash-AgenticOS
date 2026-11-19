-- Existing Autopilot enrollments predate full-access T3 sessions.
alter table autopilot add column t3_sessions integer not null default 0;
alter table autopilot add column sv_effort text;
