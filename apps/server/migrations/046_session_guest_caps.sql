-- What the owner lets teammates' requests use in a session without asking them, comma-separated (agent guest.ts):
-- drive, tailnet, github, apps, commands. Empty, the default: everything that would use the owner's access asks them.
alter table claude_sessions add column guest_caps text not null default '';
