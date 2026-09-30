-- Load-test user pool for auth_server (see run-load.sh).
-- 100 users with a bcrypt cost-10 hash and 100 with cost-12 — the login
-- storm compares the two pools to price the bcrypt cost increase.
-- Password for every user: LoadPass123!
-- Idempotent: re-running tops up to the same fixed pool.

INSERT INTO accounts (username, password, is_activated)
SELECT 'load_' || i || '@test.local',
       '$2a$10$5cMkpXG4.QZXf6mmQ9GzguHwswbTHgG/PPADA5RuabDyrYJib10Py',
       1
FROM generate_series(0, 99) i
WHERE NOT EXISTS (
  SELECT 1 FROM accounts WHERE username = 'load_' || i || '@test.local'
);

INSERT INTO accounts (username, password, is_activated)
SELECT 'load12_' || i || '@test.local',
       '$2a$12$0CmOQfVIryaOpdTSnrHgZenl8857226pTWDMKVKW88c38uW6cuEtG',
       1
FROM generate_series(0, 99) i
WHERE NOT EXISTS (
  SELECT 1 FROM accounts WHERE username = 'load12_' || i || '@test.local'
);
