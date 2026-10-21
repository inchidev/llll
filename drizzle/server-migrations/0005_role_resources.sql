-- Role capabilities and resource boundaries are independent. Existing resource access is preserved.
ALTER TABLE roles ADD COLUMN resource_access_json TEXT NOT NULL DEFAULT '{}';
