-- Team authorship, part 2: backfill via_role on rows a team role wrote BEFORE 031 started recording it, wherever the role
-- can be determined. Only rows with via_role IS NULL are touched, and every row changed is recorded in
-- team_authorship_backfill (kind, row_id, role), so the backfill can be undone without touching anything created later.
--
-- Determinable:
--   task_comment  a Claude-written comment whose body starts "<Role>, " (or "**<Role>, ", bold) for a role of the task's
--                 project, exact case. Longest matching role name wins ("CEO Ops" over "CEO").
--   task          a task linked from a team proposal's outcome ("…(/tasks/<slug>/<number>)…") of kind task or other;
--                 the proposing role. The newest such proposal wins.
--   activity      only kind 'task.created' written via Claude: inherits the role of the task its url points at, after the
--                 task step. task.status / task.comment entries are left alone: who triggered them is ambiguous.
-- Not determinable: notes. They carry no role or session link and no "<Role>, " prefix, so they are left as they are;
-- the author can set it by editing the note.
--
-- UNDO (run in this order; each line is one statement):
-- undo: update task_comments set via_role = null where id in (select row_id from team_authorship_backfill where kind = 'task_comment');
-- undo: update tasks set via_role = null where id in (select row_id from team_authorship_backfill where kind = 'task');
-- undo: update activity set via_role = null where id in (select row_id from team_authorship_backfill where kind = 'activity');
-- undo: drop table team_authorship_backfill;

create table if not exists team_authorship_backfill (
  kind text not null check (kind in ('task_comment', 'task', 'activity')),
  row_id integer not null,
  role text not null,
  primary key (kind, row_id)
);

-- 1. Task comments: "<Role>, …" from a Claude session.
insert or ignore into team_authorship_backfill (kind, row_id, role)
  select 'task_comment', c.id,
    (select r.name from team_roles r join tasks t on t.id = c.task_id
      where r.project_id = t.project_id
        and (substr(c.body, 1, length(r.name) + 2) = r.name || ', '
          or substr(c.body, 1, length(r.name) + 4) = '**' || r.name || ', ')
      order by length(r.name) desc limit 1)
  from task_comments c
  where c.via_claude = 1 and c.via_role is null
    and exists (select 1 from team_roles r join tasks t on t.id = c.task_id
      where r.project_id = t.project_id
        and (substr(c.body, 1, length(r.name) + 2) = r.name || ', '
          or substr(c.body, 1, length(r.name) + 4) = '**' || r.name || ', '));

update task_comments
  set via_role = (select b.role from team_authorship_backfill b where b.kind = 'task_comment' and b.row_id = task_comments.id)
  where via_role is null and id in (select row_id from team_authorship_backfill where kind = 'task_comment');

-- 2. Tasks a team proposal created ("It's a task for …: [slug#N](/tasks/slug/N)").
insert or ignore into team_authorship_backfill (kind, row_id, role)
  select 'task', t.id,
    (select r.name from team_proposals p join team_roles r on r.id = p.role_id join projects pr on pr.id = t.project_id
      where p.project_id = t.project_id and p.kind in ('task', 'other')
        and p.outcome like '%/tasks/' || pr.slug || '/' || t.number || ')%'
      order by p.id desc limit 1)
  from tasks t
  where t.via_role is null
    and exists (select 1 from team_proposals p join projects pr on pr.id = t.project_id
      where p.project_id = t.project_id and p.kind in ('task', 'other')
        and p.outcome like '%/tasks/' || pr.slug || '/' || t.number || ')%');

update tasks
  set via_role = (select b.role from team_authorship_backfill b where b.kind = 'task' and b.row_id = tasks.id)
  where via_role is null and id in (select row_id from team_authorship_backfill where kind = 'task');

-- 3. The "task created" activity entry of those tasks.
insert or ignore into team_authorship_backfill (kind, row_id, role)
  select 'activity', a.id, t.via_role
  from activity a
    join projects pr on pr.id = a.project_id
    join tasks t on t.project_id = a.project_id and a.url = '/tasks/' || pr.slug || '/' || t.number
  where a.via_claude = 1 and a.via_role is null and a.kind = 'task.created' and t.via_role is not null;

update activity
  set via_role = (select b.role from team_authorship_backfill b where b.kind = 'activity' and b.row_id = activity.id)
  where via_role is null and id in (select row_id from team_authorship_backfill where kind = 'activity');
