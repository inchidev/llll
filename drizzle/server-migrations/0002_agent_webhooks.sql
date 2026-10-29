-- An external Agent works on its own computer. Its Runs wake it through this webhook and it
-- answers through the Server's MCP in the Run's thread; the Server never calls a model for it.
CREATE TABLE agent_webhooks (
  agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agents(user_id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  header_name TEXT NOT NULL DEFAULT 'Authorization',
  credential_json TEXT,
  reply_timeout_minutes INTEGER NOT NULL DEFAULT 20 CHECK(reply_timeout_minutes BETWEEN 2 AND 120),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
