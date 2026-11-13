-- The model Claude Code's advisor tool consults in this session (opus, sonnet, fable); null: no advisor, the default.
alter table claude_sessions add column advisor_model text;
