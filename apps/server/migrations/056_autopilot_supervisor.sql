-- Per-member supervisor settings: which agent, profile and model the supervisor runs on, and a daily cap for agents
-- whose plan usage can't be read (OpenCode). Default: today's behaviour (Claude Code, default profile, Sonnet).
alter table autopilot add column sv_harness text not null default 'claude';
alter table autopilot add column sv_profile text not null default 'default';
alter table autopilot add column sv_model text not null default 'sonnet';
alter table autopilot add column sv_daily_cap integer not null default 100;
-- Rolling counter of supervisor model calls since the last reset (nightStart). For the daily cap.
alter table autopilot add column sv_model_calls integer not null default 0;
alter table autopilot add column sv_model_calls_since integer not null default 0;
