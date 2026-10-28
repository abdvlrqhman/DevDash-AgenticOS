-- Long-running processes (web servers, APIs, workers, containers) that members and their Claude sessions run.
-- Each gets its own port, so nothing collides; desired = 'running' means DevDash keeps it up, across crashes and reboots.
create table services (
  id integer primary key,
  name text not null unique,
  owner_id integer not null references users(id) on delete cascade,
  cwd text not null,
  command text not null,
  port integer not null unique check (port between 20000 and 20999),
  desired text not null default 'running' check (desired in ('running', 'stopped')),
  created_at integer not null default (unixepoch())
);
