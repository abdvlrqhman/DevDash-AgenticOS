-- Claude Code reports a session's running total cost with each answer (carried over when a session resumes), not the
-- answer's own. `cost_usd` keeps that running total; `turn_cost_usd` is the answer's own: this total minus the one
-- before it, or unknown (null) for the first answer recorded in a session that began before DevDash saved them.
alter table claude_turns add column turn_cost_usd real;
update claude_turns set turn_cost_usd = claude_turns.cost_usd - p.prev
  from (select id, lag(cost_usd) over (partition by session_id order by id) as prev from claude_turns) as p
  where p.id = claude_turns.id and p.prev is not null and claude_turns.cost_usd >= p.prev;
-- The model saved so far was the first one the session had used, often the small one Claude Code uses for titles.
update claude_turns set model = null;
