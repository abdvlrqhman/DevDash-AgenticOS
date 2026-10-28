-- Team: help the founder instead of overwhelming them. One clear ask per thread, the founder's priorities above the
-- roles' plans, people-marked blockers, and a lead that clears routine approvals so fewer reach a person. All team_*.

-- When a thread goes to people, the one decision its owner needs from them (shown first, in the thread and the alert).
alter table team_threads add column ask text;
-- A person can mark a thread a blocker: the owning role treats it as top priority, and it sorts first for everyone.
alter table team_threads add column priority text not null default 'normal' check (priority in ('normal', 'blocker'));

-- What matters now, in the founder's words. Injected near the top of every role's context, above its own goals.
alter table team_projects add column priorities text not null default '';

-- A routine task/goal proposal can wait for the lead to clear it ('lead') instead of every one reaching a person.
alter table team_proposals add column awaiting text not null default 'people' check (awaiting in ('people', 'lead'));
-- When the lead (a role, not a person) decides a proposal, which role it was (decided_by stays for people).
alter table team_proposals add column decided_by_role integer references team_roles(id) on delete set null;
