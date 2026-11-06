-- Autopilot may also approve or decline permission prompts and plan approvals in the member's own sessions, by the same
-- tiers. Off unless the member turns it on.
alter table autopilot add column approvals integer not null default 0;
