-- Per-session tailnet routing: the owner can flip "Reach my tailnet" on one Claude session,
-- so that session's shell tools (ssh/curl/frida) route through the owner's userspace Tailscale SOCKS/HTTP proxy, and
-- an optional tailnet MCP (e.g. IDA Pro at http://100.x:13337/mcp) is exposed to it. Off by default; Claude's own
-- Anthropic API traffic never goes through the proxy.
alter table claude_sessions add column reach_tailnet integer not null default 0;
alter table claude_sessions add column tailnet_mcp text;
