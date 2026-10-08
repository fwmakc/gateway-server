-- Chat-storm user pool: tops the load pool up to load_0..load_599 so the
-- WS storm can connect hundreds of JWT-authenticated clients. Same bcrypt
-- cost-10 hash as seed-load.sql; password for every user: LoadPass123!
-- Idempotent: re-running tops up to the same fixed pool. Does NOT touch the
-- load12_* cost-12 comparison pool.
--
--   docker compose exec -T postgres psql -U root -d auth_server < seed-chat-storm.sql

INSERT INTO accounts (username, password, is_activated)
SELECT 'load_' || i || '@test.local',
       '$2a$10$5cMkpXG4.QZXf6mmQ9GzguHwswbTHgG/PPADA5RuabDyrYJib10Py',
       1
FROM generate_series(0, 599) i
WHERE NOT EXISTS (
  SELECT 1 FROM accounts WHERE username = 'load_' || i || '@test.local'
);
