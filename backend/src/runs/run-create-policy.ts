import { MEMORY_SCOPES, PERMISSION_MODES, type MemoryScope, type PermissionMode } from "@useagent/agent-client/wire";
import { bodyLimit } from "hono/body-limit";
import {
  assertRunPromptLimit,
  RUN_PROMPT_MAX_BYTES,
  RUN_PROMPT_MAX_CHARS,
  RunPromptTooLargeError,
} from "../commands/prompt-policy";
import { ENGINE_IDS, type EngineId } from "../db/schema";
import { isPermissionMode } from "../engines/permission-mode";
import { isMemoryScope } from "../memory/scope";
import { USER_FACING_ENGINES } from "./engine-readiness";

export const RUN_CREATE_MAX_BODY_BYTES = 256 * 1024;
export { RUN_PROMPT_MAX_BYTES, RUN_PROMPT_MAX_CHARS };

export interface RunCreateBody {
  prompt?: unknown;
  model?: unknown;
  /** A reasoning level the engine offers (see reasoning-effort.ts); absent inherits. */
  reasoning_effort?: unknown;
  engine?: unknown;
  parent_run_id?: unknown;
  repo?: unknown;
  repos?: unknown;
  branches?: unknown;
  memory_scope?: unknown;
  /** The permission policy for this run (PERMISSION_MODES); a reply inherits its parent's when absent. */
  permission_mode?: unknown;
  /** Where a root run should execute (RUN_LOCATIONS); absent is the cloud, and a reply ignores it (run-location.ts). */
  run_location?: unknown;
  skill?: unknown;
  command?: unknown;
  attachments?: unknown;
  resources?: unknown;
  /** Bot ids @mentioned in the prompt: each opens a delegated child thread on that bot's preset. */
  bot_mentions?: unknown;
  origin?: unknown;
}

export function boundedRunPrompt(value: unknown):
  | { readonly ok: true; readonly prompt: string }
  | { readonly ok: false; readonly error: "prompt is required" | "prompt_too_large"; readonly status: 400 | 413 } {
  const prompt = typeof value === "string" ? value.trim() : "";
  if (!prompt) return { ok: false, error: "prompt is required", status: 400 };
  try {
    assertRunPromptLimit(prompt);
  } catch (error) {
    if (error instanceof RunPromptTooLargeError) {
      return { ok: false, error: error.code, status: 413 };
    }
    throw error;
  }
  return { ok: true, prompt };
}

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTACHMENTS_MAX = 10;

/** `attachments`: up to ten upload ids, deduplicated; a run with any needs a person behind it. */
export function runAttachmentIds(value: unknown, hasUser: boolean):
  | { readonly ok: true; readonly ids: string[] }
  | { readonly ok: false; readonly error: string; readonly status: 400 | 401 } {
  const raw = value ?? [];
  if (!Array.isArray(raw) || raw.length > ATTACHMENTS_MAX) {
    return { ok: false, error: `attachments must be an array of at most ${ATTACHMENTS_MAX} upload ids`, status: 400 };
  }
  const ids = [...new Set(raw)];
  if (ids.some((id) => typeof id !== "string" || !UPLOAD_ID.test(id))) {
    return { ok: false, error: "attachments contain an invalid upload id", status: 400 };
  }
  if (ids.length > 0 && !hasUser) {
    return { ok: false, error: "authenticated user required for attachments", status: 401 };
  }
  return { ok: true, ids: ids as string[] };
}

export const runCreateBodyLimit = bodyLimit({
  maxSize: RUN_CREATE_MAX_BODY_BYTES,
  onError: (c) => c.json({ error: "request_too_large" }, 413),
});

/** `memory_scope`: an explicit, validated choice wins; a reply inherits its
 *  parent's; a root run defaults to "org". Only the enum is read from the body,
 *  never an identity; an unknown value is a client error, not a fallback. */
export function runMemoryScope(value: unknown, inherited: MemoryScope | null):
  | { readonly ok: true; readonly memoryScope: MemoryScope; readonly requestedMemoryScope: MemoryScope | null }
  | { readonly ok: false; readonly error: string } {
  if (value === undefined || value === null) {
    return { ok: true, memoryScope: inherited ?? "org", requestedMemoryScope: null };
  }
  if (!isMemoryScope(value)) {
    return { ok: false, error: `memory_scope must be one of: ${MEMORY_SCOPES.join(", ")}` };
  }
  return { ok: true, memoryScope: value, requestedMemoryScope: value };
}

/** `permission_mode`: an explicit, validated choice; when absent the mode stays
 *  unset here on purpose, so the insert resolves it under the thread lock (a
 *  reply keeps the thread's mode as it stands at acceptance, a root run takes
 *  the operator's configured posture) instead of a value read before it. */
/** `model` (trimmed, or null when absent) and `engine` (one of the engine ids,
 *  or null when absent); an unknown engine is a client error naming the
 *  user-facing ones. */
export function runModelAndEngine(body: Pick<RunCreateBody, "model" | "engine">):
  | { readonly ok: true; readonly model: string | null; readonly engine: EngineId | null }
  | { readonly ok: false; readonly error: string } {
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
  if (body.engine === undefined || body.engine === null || body.engine === "") {
    return { ok: true, model, engine: null };
  }
  if (typeof body.engine !== "string" || !(ENGINE_IDS as readonly string[]).includes(body.engine)) {
    return { ok: false, error: `engine must be one of: ${USER_FACING_ENGINES.join(", ")}` };
  }
  return { ok: true, model, engine: body.engine as EngineId };
}

export function runPermissionMode(value: unknown):
  | { readonly ok: true; readonly permissionMode: PermissionMode | undefined }
  | { readonly ok: false; readonly error: string } {
  if (value === undefined || value === null) return { ok: true, permissionMode: undefined };
  if (!isPermissionMode(value)) {
    return { ok: false, error: `permission_mode must be one of: ${PERMISSION_MODES.join(", ")}` };
  }
  return { ok: true, permissionMode: value };
}
