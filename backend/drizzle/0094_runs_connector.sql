-- fast-deploy: expansion-safe
-- Who sent a connector-born turn (Slack): the sender's display name and avatar as
-- the channel showed them at ingress, plus the message permalink. Null for turns
-- typed in the product. `connector_lookup` is the lookup still owed for that
-- stamp, durable before the inbox claim completes and swept at boot.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "connector" jsonb;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "connector_lookup" jsonb;
