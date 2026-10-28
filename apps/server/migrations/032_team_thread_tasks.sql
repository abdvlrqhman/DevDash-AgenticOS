-- Team, "one job per object": the two-way link between a thread (where a topic is discussed and decided) and a task
-- (the work it turns into, with an owner and a done state), so a topic lives in one place and each side points at the
-- other — "Task shop#10" on the thread, "From thread #7" on the task. team_* only: it points
-- at core tasks one way (team -> core is fine; core never points at team). A task belongs to at most one thread; a
-- thread can produce several tasks. Dropping it, or either side, removes the link cleanly.
create table team_thread_tasks (
  thread_id integer not null references team_threads(id) on delete cascade,
  task_id integer not null references tasks(id) on delete cascade,
  created_at integer not null default (unixepoch()),
  primary key (task_id)
);
create index team_thread_tasks_thread on team_thread_tasks(thread_id);
