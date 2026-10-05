-- fast-deploy: expansion-safe
-- The command catalog a native session advertises, one row per (thread, engine,
-- session), replaced in place with a rising revision whenever the list changes.
-- The reply composer's Compact action and typed commands are authorized against
-- exactly this row (runs/command-catalog.ts); it is written best effort by the
-- runtime adapter and is never part of a run's provider-event sequence.
CREATE TABLE IF NOT EXISTS "session_command_catalogs" (
	"thread_id" text NOT NULL,
	"provider" text NOT NULL,
	"native_session_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"commands" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_command_catalogs_pk" PRIMARY KEY("thread_id","provider","native_session_id")
);
