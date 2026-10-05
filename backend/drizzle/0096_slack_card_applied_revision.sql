-- fast-deploy: expansion-safe
-- The exact revision the thread card currently shows, kept apart from the
-- monotonic high-water mark `card_revision`: a replayed revision is told by
-- equality, a superseded one by the mark, whatever was reposted in between.
ALTER TABLE "slack_threads" ADD COLUMN "card_applied_revision" bigint;
