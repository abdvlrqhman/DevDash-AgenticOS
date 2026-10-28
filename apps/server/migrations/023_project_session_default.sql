-- How new Claude sessions in a project start out: private to their owner, shared to watch, or shared so anyone can send.
-- Only the starting point: the owner still changes each session's sharing afterwards. Features that set their own
-- (a team role's sessions) keep theirs.
alter table projects add column session_sharing text not null default 'private'
  check (session_sharing in ('private', 'shared', 'shared_can_send'));
