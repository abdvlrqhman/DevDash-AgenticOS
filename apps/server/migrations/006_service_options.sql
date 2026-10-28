-- Service options, and which Claude session started a service (when Claude did).
alter table services add column session_id text references claude_sessions(id) on delete set null;
alter table services add column autostart integer not null default 1; -- start it when the server starts
alter table services add column restart integer not null default 1;   -- restart it when it crashes
alter table services add column env text not null default '';         -- KEY=value lines
