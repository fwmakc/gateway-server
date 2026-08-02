INSERT INTO posts_by_posts_tags ("postsId", "postsTagsId")
SELECT p.id, (random() * 29 + 1)::bigint
FROM posts p
CROSS JOIN generate_series(1, 5) g
ON CONFLICT DO NOTHING;
