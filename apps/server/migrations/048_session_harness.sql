-- Which coding agent runs a session (agent harness.ts): Claude Code, or OpenCode. Sessions so far were all Claude Code.
alter table claude_sessions add column harness text not null default 'claude';
-- The harness's own id for the session, when it can't use DevDash's (OpenCode makes its own "ses_…" ids). Claude Code
-- takes DevDash's id as its own, so it has none.
alter table claude_sessions add column native_id text;
-- Which one a member's new sessions start with.
alter table claude_defaults add column harness text not null default 'claude';
