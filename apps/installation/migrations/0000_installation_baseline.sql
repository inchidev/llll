PRAGMA foreign_keys = ON;
CREATE TABLE auth_users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE TABLE auth_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, password TEXT, access_token TEXT, refresh_token TEXT, id_token TEXT, scope TEXT, access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(provider_id, account_id));
CREATE TABLE auth_verifications (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER, updated_at INTEGER);
CREATE TABLE installation_meta (id INTEGER PRIMARY KEY CHECK(id = 1), owner_id TEXT REFERENCES auth_users(id), setup_claim TEXT, created_at INTEGER NOT NULL);
CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES auth_users(id), origin TEXT NOT NULL UNIQUE, worker_name TEXT, secret TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('provisioning','ready','failed')), error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE memberships (server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('owner','member')), created_at INTEGER NOT NULL, PRIMARY KEY(server_id,user_id));
CREATE INDEX memberships_user ON memberships(user_id);
CREATE TABLE invites (token_hash TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, created_by TEXT NOT NULL REFERENCES auth_users(id), expires_at INTEGER NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER);
CREATE TABLE audit (id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE integration_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Optional installation OIDC provider.
CREATE TABLE jwks (id TEXT PRIMARY KEY, public_key TEXT NOT NULL, private_key TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, alg TEXT, crv TEXT);
CREATE TABLE oauth_client (id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE, client_secret TEXT, client_discovery_id TEXT, disabled INTEGER DEFAULT 0, skip_consent INTEGER, enable_end_session INTEGER, subject_type TEXT, scopes TEXT, client_credentials_scopes TEXT DEFAULT '[]', user_id TEXT REFERENCES auth_users(id) ON DELETE NO ACTION, created_at INTEGER, updated_at INTEGER, name TEXT, uri TEXT, icon TEXT, contacts TEXT, tos TEXT, policy TEXT, software_id TEXT, software_version TEXT, software_statement TEXT, redirect_uris TEXT NOT NULL, post_logout_redirect_uris TEXT, backchannel_logout_uri TEXT, backchannel_logout_session_required INTEGER, token_endpoint_auth_method TEXT, application_type TEXT, jwks TEXT, jwks_uri TEXT, grant_types TEXT, response_types TEXT, require_p_k_c_e INTEGER, dpop_bound_access_tokens INTEGER DEFAULT 0, reference_id TEXT, metadata TEXT);
CREATE INDEX oauth_client_user_id ON oauth_client(user_id);
CREATE TABLE oauth_resource (id TEXT PRIMARY KEY, identifier TEXT NOT NULL UNIQUE, name TEXT NOT NULL, access_token_ttl INTEGER, refresh_token_ttl INTEGER, signing_algorithm TEXT, signing_key_id TEXT, allowed_scopes TEXT, custom_claims TEXT, dpop_bound_access_tokens_required INTEGER DEFAULT 0, disabled INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER, policy_version INTEGER DEFAULT 1, metadata TEXT);
CREATE TABLE oauth_client_resource (id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE, resource_id TEXT NOT NULL REFERENCES oauth_resource(identifier) ON DELETE CASCADE, metadata TEXT, created_at INTEGER, UNIQUE (client_id, resource_id));
CREATE INDEX oauth_client_resource_client_id ON oauth_client_resource(client_id);
CREATE INDEX oauth_client_resource_resource_id ON oauth_client_resource(resource_id);
CREATE TABLE oauth_refresh_token (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL REFERENCES oauth_client(client_id) ON DELETE NO ACTION, session_id TEXT REFERENCES auth_sessions(id) ON DELETE SET NULL, user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE NO ACTION, reference_id TEXT, authorization_code_id TEXT, resources TEXT, requested_user_info_claims TEXT, expires_at INTEGER, created_at INTEGER, revoked INTEGER, rotated_at INTEGER, rotation_replay_response TEXT, rotation_replay_expires_at INTEGER, auth_time INTEGER, confirmation TEXT, scopes TEXT NOT NULL);
CREATE INDEX oauth_refresh_token_client_id ON oauth_refresh_token(client_id);
CREATE INDEX oauth_refresh_token_session_id ON oauth_refresh_token(session_id);
CREATE INDEX oauth_refresh_token_user_id ON oauth_refresh_token(user_id);
CREATE INDEX oauth_refresh_token_authorization_code_id ON oauth_refresh_token(authorization_code_id);
CREATE TABLE oauth_access_token (id TEXT PRIMARY KEY, token TEXT UNIQUE, client_id TEXT NOT NULL REFERENCES oauth_client(client_id) ON DELETE NO ACTION, session_id TEXT REFERENCES auth_sessions(id) ON DELETE SET NULL, user_id TEXT REFERENCES auth_users(id) ON DELETE NO ACTION, reference_id TEXT, authorization_code_id TEXT, resources TEXT, requested_user_info_claims TEXT, refresh_id TEXT REFERENCES oauth_refresh_token(id) ON DELETE NO ACTION, expires_at INTEGER, created_at INTEGER, revoked INTEGER, confirmation TEXT, scopes TEXT NOT NULL);
CREATE INDEX oauth_access_token_client_id ON oauth_access_token(client_id);
CREATE INDEX oauth_access_token_session_id ON oauth_access_token(session_id);
CREATE INDEX oauth_access_token_user_id ON oauth_access_token(user_id);
CREATE INDEX oauth_access_token_authorization_code_id ON oauth_access_token(authorization_code_id);
CREATE INDEX oauth_access_token_refresh_id ON oauth_access_token(refresh_id);
CREATE TABLE oauth_consent (id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES oauth_client(client_id) ON DELETE NO ACTION, user_id TEXT REFERENCES auth_users(id) ON DELETE NO ACTION, reference_id TEXT, resources TEXT, requested_user_info_claims TEXT, scopes TEXT NOT NULL, created_at INTEGER, updated_at INTEGER);
CREATE INDEX oauth_consent_client_id ON oauth_consent(client_id);
CREATE INDEX oauth_consent_user_id ON oauth_consent(user_id);
CREATE TABLE oauth_client_assertion (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);

CREATE TABLE connection_grants (code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE, session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE, challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX connection_grants_expires ON connection_grants(expires_at);

CREATE TABLE account_recovery (user_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE, code_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE recovery_attempts (id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);

CREATE TABLE invitation_admissions (token_hash TEXT NOT NULL REFERENCES invites(token_hash) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,PRIMARY KEY(token_hash,user_id));
