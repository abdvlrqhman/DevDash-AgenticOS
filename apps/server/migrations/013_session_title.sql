-- 1 once the owner renamed a session in DevDash: their title wins over the one Claude Code generates.
alter table claude_sessions add column title_custom integer not null default 0;
