-- Accounts
INSERT INTO accounts (username, password, is_activated, is_superuser)
SELECT 'user_' || i, 'hashed_password', 1, CASE WHEN i = 1 THEN 1 ELSE 0 END
FROM generate_series(1, 5) i;

-- Categories
INSERT INTO posts_categories (title)
SELECT 'Category ' || i FROM generate_series(1, 10) i;

-- Tags
INSERT INTO posts_tags (title)
SELECT 'Tag ' || i FROM generate_series(1, 30) i;

-- Posts (200)
INSERT INTO posts (title, content, published_at, is_published, secret_notes, view_count, account_id, posts_category_id, created_at, updated_at)
SELECT
  'Post Title ' || i,
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. ' || i,
  NOW() - (random() * interval '90 days'),
  CASE WHEN random() > 0.2 THEN 1 ELSE 0 END,
  CASE WHEN random() > 0.7 THEN 'Secret note for post ' || i ELSE NULL END,
  (random() * 10000)::int,
  (random() * 4 + 1)::bigint,
  (random() * 9 + 1)::bigint,
  NOW() - (random() * interval '90 days'),
  NOW() - (random() * interval '30 days')
FROM generate_series(1, 200) i;

-- Post-Tag links (~3-5 tags per post)
INSERT INTO posts_by_posts_tags ("postsId", "postsTagsId")
SELECT p.id, (random() * 29 + 1)::bigint
FROM posts p
CROSS JOIN generate_series(1, (random() * 3 + 2)::int) g
WHERE random() > 0.3;
