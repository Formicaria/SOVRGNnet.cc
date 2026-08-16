-- Dendrite gets its own database inside the PostgreSQL instance the app
-- already runs. One engine, one backup, one thing to restore — where Conduit
-- kept a separate RocksDB store alongside.
--
-- Runs only when the data directory is first created. An instance upgrading
-- from Conduit already has an initialised cluster, so this will NOT run there
-- and the database must be created by hand:
--
--   docker compose exec db psql -U sovrgn -d postgres -c 'CREATE DATABASE dendrite OWNER sovrgn'
--
-- See docs/adr/0006-dendrite-replaces-conduit.md.

CREATE DATABASE dendrite OWNER sovrgn;
