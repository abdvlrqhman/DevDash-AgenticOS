-- Options a DevDash feature can give a Claude session it starts for someone (a person's own sessions have none).
-- Added to Claude's system prompt after DevDash's own rules.
alter table claude_sessions add column instructions text;
-- JSON {"tools": [...built-in tools it has], "allow": [...tools that run without asking]}.
alter table claude_sessions add column tool_policy text;
-- 0 keeps the session out of the session lists (it is still opened by its link).
alter table claude_sessions add column listed integer not null default 1;
