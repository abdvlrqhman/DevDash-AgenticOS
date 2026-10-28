-- Backfill: sessions started by approving a role's code proposal (origin added in 027, unlisting added later) existed
-- before those changes as plain listed sessions, so they cluttered the global session list. Tag each from the proposal
-- that spawned it (its outcome links `/claude/<id>`) and unlist it, so it moves into the project's "From approvals"
-- group. team_proposals is always present in the schema (migrations 016/018); only its runtime service is optional.
update claude_sessions set
  origin_kind = 'proposal',
  origin_role = coalesce((select r.name from team_proposals p join team_roles r on r.id = p.role_id
    where p.kind = 'code' and p.outcome like '%/claude/' || claude_sessions.id || ')%' order by p.id limit 1), origin_role),
  listed = 0
where origin_kind is null
  and exists (select 1 from team_proposals p where p.kind = 'code' and p.outcome like '%/claude/' || claude_sessions.id || ')%');
