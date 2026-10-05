-- fast-deploy: expansion-safe
CREATE TABLE "runners" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"backend" text,
	"version" text,
	"protocol" integer,
	"capacity" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"logins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"image_digest" text,
	"status" text DEFAULT 'enrolled' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"token_hash" text NOT NULL,
	CONSTRAINT "runners_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX "runners_org_user_idx" ON "runners" USING btree ("org_id","user_id");
--> statement-breakpoint
CREATE INDEX "runners_status_idx" ON "runners" USING btree ("status");
--> statement-breakpoint
CREATE TABLE "runner_policies" (
	"org_id" text PRIMARY KEY NOT NULL,
	"allow_local_execution" boolean DEFAULT true NOT NULL,
	"allow_local_logins" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
