-- fast-deploy: expansion-safe
-- A member's model key the provider rejected (expired or revoked) leaves
-- `connected` for reauth_required until a new key is saved; status_reason
-- records why as the HTTP status only, never the provider's answer. The
-- gateway marks it through its view, so the view carries the column too.
ALTER TABLE "provider_connections" ADD COLUMN IF NOT EXISTS "status_reason" text;
--> statement-breakpoint
CREATE OR REPLACE VIEW "gateway_provider_api_key_credentials" AS
	SELECT
		"org_id",
		"user_id",
		"provider",
		"auth_method",
		"status",
		"credential_ciphertext",
		"iv",
		"tag",
		"metadata",
		"updated_at",
		"status_reason"
	FROM "provider_connections"
	WHERE "auth_method" = 'api_key'
		AND "status" = 'connected';
