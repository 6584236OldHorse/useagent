-- fast-deploy: expansion-safe
-- Sandbox minutes ledger: one entry per settled run, charged to its member from
-- the lifetimes of the sandbox leases the run held (the double-count guard is
-- the primary key), and each member's preferred sandbox provider.
CREATE TABLE IF NOT EXISTS "sandbox_minutes_entries" (
	"charge_key" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"seconds" integer NOT NULL,
	"sandboxes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sandbox_minutes_entries_org_user" ON "sandbox_minutes_entries" ("org_id","user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sandbox_preferences" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_preferences_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
