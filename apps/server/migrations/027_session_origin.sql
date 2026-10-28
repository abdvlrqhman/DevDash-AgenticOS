-- Where a session came from, when it wasn't a person starting it themselves. A team role's approved *code* proposal
-- starts a real Claude session as the approver (team/service.ts execute()); mark it so it doesn't blend into the
-- approver's own sessions. Null for normal sessions; 'proposal' with the role's name for those.
alter table claude_sessions add column origin_kind text;
alter table claude_sessions add column origin_role text;
