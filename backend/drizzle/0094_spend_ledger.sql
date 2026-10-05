-- fast-deploy: expansion-safe
-- Spend ledger: each member's allowance and settled spend per organisation, and
-- the per-run charge that keeps accrual idempotent.
CREATE TABLE IF NOT EXISTS "spend_accounts" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"allowance_usd" numeric(14, 6),
	"spent_usd" numeric(14, 6) DEFAULT 0 NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_accounts_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "spend_entries" (
	"run_id" text PRIMARY KEY NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"cost_usd" numeric(14, 6) NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
