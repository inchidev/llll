CREATE TABLE mcp_outbound_connections (
  id TEXT PRIMARY KEY NOT NULL,
  server_id TEXT NOT NULL REFERENCES server(id) ON DELETE CASCADE,
  owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  grants_json TEXT NOT NULL,
  tool_names_json TEXT NOT NULL,
  tools_json TEXT NOT NULL DEFAULT '[]',
  credential_json TEXT,
  credential_expires_at TEXT,
  checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX mcp_outbound_server_owner ON mcp_outbound_connections(server_id,owner_id);
