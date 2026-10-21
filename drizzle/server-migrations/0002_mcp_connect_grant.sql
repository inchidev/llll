-- Enable the new grant only for the built-in owner role. Other roles keep their
-- existing permissions and require an explicit opt-in to MCP access.
UPDATE roles SET permissions_bitmask = permissions_bitmask | 4096 WHERE key = 'owner';
