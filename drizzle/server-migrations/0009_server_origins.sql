CREATE TABLE server_domains (
  origin TEXT PRIMARY KEY NOT NULL,
  hostname TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CONSTRAINT server_domains_primary_check CHECK (is_primary IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX server_domains_hostname_unique ON server_domains (hostname);
--> statement-breakpoint
CREATE UNIQUE INDEX server_domains_single_primary ON server_domains (is_primary) WHERE is_primary = 1;
--> statement-breakpoint
CREATE TABLE server_domain_requests (
  id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL,
  hostname TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT server_domain_requests_action_check CHECK (action IN ('add', 'remove', 'primary')),
  CONSTRAINT server_domain_requests_status_check CHECK (status IN ('pending', 'running', 'complete', 'failed'))
);
--> statement-breakpoint
CREATE INDEX server_domain_requests_status_idx ON server_domain_requests (status, created_at);
