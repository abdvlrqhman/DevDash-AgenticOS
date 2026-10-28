-- Multiple tailnet MCPs per session: instead of one URL, a session can expose several tailnet
-- MCP servers (e.g. IDA on one box and another tool elsewhere), each with its own name. Stored as a JSON array of
-- {name, url}. The old single `tailnet_mcp` column is carried into the array (named "ida") and then left unused.
alter table claude_sessions add column tailnet_mcps text;
update claude_sessions set tailnet_mcps = json_array(json_object('name', 'ida', 'url', tailnet_mcp))
  where tailnet_mcp is not null and trim(tailnet_mcp) != '';
