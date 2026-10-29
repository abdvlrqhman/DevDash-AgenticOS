-- Sharing a session in levels. Watch: see it and comment. Ask: send messages, but anything that would use the owner's
-- access (commands, their accounts, files outside the shared folders) waits for the owner's approval. Full access: send
-- messages that run with the owner's access, as before; only for people the owner names.
alter table claude_session_writers add column full_access integer not null default 0;
