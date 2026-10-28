-- Project instructions: a set of rules you give once (like a Claude Project's instructions). Every Claude session
-- started in the project follows them — they're added to the session's system prompt. Optional, empty by default.
alter table projects add column instructions text not null default '';
