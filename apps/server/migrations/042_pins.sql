-- Each member's own shortcuts in the sidebar: projects, Claude sessions, tasks, notes and services they pinned, in
-- their order. `ref` is the item's stable handle (a project slug, a session id, "slug/number" for a task, a note id, a
-- service name). A pin to something the member can no longer see is kept but not shown, so it comes back if they can.
create table pins (
  user_id integer not null references users(id) on delete cascade,
  kind text not null check (kind in ('project', 'session', 'task', 'note', 'service')),
  ref text not null,
  position integer not null,
  created_at integer not null default (unixepoch()),
  primary key (user_id, kind, ref)
);
