-- Persistent multi-step browser agent runs with working memory, step logs, and human-in-the-loop pause/resume.
create table browser_runs (
  id             integer primary key autoincrement,
  user_id        integer not null references users(id) on delete cascade,
  turn_id        integer references browser_chat_turns(id) on delete set null,
  request_id     text,
  goal           text not null,
  status         text not null default 'running'
    check (status in ('running', 'waiting_user', 'paused', 'completed', 'failed', 'cancelled')),
  plan_json      text not null default '[]',
  scratchpad     text not null default '',
  pause_reason   text,
  steering_json  text not null default '[]',
  step_count     integer not null default 0,
  max_steps      integer not null default 50,
  max_runtime_ms integer not null default 1200000,
  started_at     integer not null default (unixepoch()),
  updated_at     integer not null default (unixepoch()),
  finished_at    integer,
  result         text
);

create index idx_browser_runs_user on browser_runs(user_id, id desc);
create index idx_browser_runs_status on browser_runs(status);

create table browser_run_steps (
  id          integer primary key autoincrement,
  run_id      integer not null references browser_runs(id) on delete cascade,
  seq         integer not null,
  action_json text not null,
  url         text not null default '',
  summary     text not null default '',
  error       text,
  created_at  integer not null default (unixepoch())
);

create index idx_browser_run_steps_run on browser_run_steps(run_id, seq);
