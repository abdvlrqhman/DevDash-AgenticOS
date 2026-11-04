-- Which coding agent a team role works with (its shifts and its chat): Claude Code, or OpenCode. Its `model` is then
-- that agent's: a Claude family (opus, sonnet, haiku), or OpenCode's provider/model id.
alter table team_roles add column harness text not null default 'claude';
