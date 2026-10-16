ALTER TABLE servers ADD COLUMN public_id TEXT;
UPDATE servers SET public_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random() % 4) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)));
CREATE UNIQUE INDEX servers_public_id_unique ON servers(public_id);

CREATE TABLE oauth_refresh_lock (id INTEGER PRIMARY KEY CHECK(id=1), lease_until INTEGER NOT NULL);
