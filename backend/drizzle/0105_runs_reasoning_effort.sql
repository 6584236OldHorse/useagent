-- fast-deploy: expansion-safe
-- The reasoning effort a run was accepted with (Codex: the app-server turn's
-- effort; Claude Code: the agent's effort). Null runs on the runtime's default;
-- a reply inherits its parent's value the way it inherits the model.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "reasoning_effort" text;
