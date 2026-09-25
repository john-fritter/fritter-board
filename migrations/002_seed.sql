-- Starting structure from the spec: News, General, Off-Topic, Site Business,
-- and the members-only Back Room. Boards are looked up by slug, never by id.

INSERT INTO board.ranks (min_posts, title) VALUES
  (0,    'Newcomer'),
  (10,   'Member'),
  (50,   'Regular'),
  (200,  'Old Hand'),
  (500,  'Fixture'),
  (1000, 'Part of the Furniture'),
  (2500, 'Load-Bearing Wall');

WITH cats AS (
  INSERT INTO board.categories (name, sort_order) VALUES
    ('The Paper',     10),
    ('The Commons',   20),
    ('Site Business', 30),
    ('Members',       40)
  RETURNING id, name
)
INSERT INTO board.boards (category_id, slug, name, description, members_only, sort_order)
SELECT cats.id, b.slug, b.name, b.description, b.members_only, b.sort_order
FROM (VALUES
  ('The Paper',     'news',          'News',          'Discussion of Fritter Post articles.',               FALSE, 10),
  ('The Commons',   'general',       'General',       'Anything worth talking about.',                      FALSE, 10),
  ('The Commons',   'off-topic',     'Off-Topic',     'Anything not worth talking about.',                  FALSE, 20),
  ('Site Business', 'site-business', 'Site Business', 'Rules, announcements, and the moderation log.',      FALSE, 10),
  ('Members',       'back-room',     'Back Room',     'Members only. Never shown to the public.',           TRUE,  10)
) AS b (category, slug, name, description, members_only, sort_order)
JOIN cats ON cats.name = b.category;
