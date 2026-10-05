-- fast-deploy: expansion-safe
-- Who sent a connector-born turn (Slack): the sender's display name and avatar as
-- the channel showed them at ingress, plus the message permalink. Null for turns
-- typed in the product.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "connector" jsonb;
