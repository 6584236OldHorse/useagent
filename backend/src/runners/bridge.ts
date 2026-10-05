// The bridge from the tool gateway to a runner's link. The gateway runs as a
// separate process with no links of its own; its sandbox-bound tools reach a
// machine through these routes on the backend, authenticated by the same
// signed capability the GitHub bridge uses and admitted only while its run is
// running. A capability reaches exactly one container, the one recorded on
// its run, and only the operations a run's tools perform inside it.
//
//   POST /bridge/call            {runnerId, method, params, timeoutMs} -> {result} | {error:{code,message}}
//   GET  /bridge/stream (ws)     ?runnerId=&target=<base64 json>; binary frames carry bytes,
//                                text frames carry {t:"opened",window}|{t:"credit",bytes}|{t:"refused"}|
//                                {t:"end"}|{t:"reset"}; the gateway may have at most `window` bytes
//                                unacknowledged, each write into the sandbox returns credit; the socket
//                                closes 1000 once the stream is done and 1011 when it failed; the
//                                capability is rechecked while the stream is open

import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import { parseLocalSandboxId } from "@useagent/runner-protocol";
import type { SandboxLinkDirectory, SandboxLinkStream } from "@useagent/sandbox-contract";
import type { AppEnv } from "../http";
import { resolveToolRunIdentity } from "../knowledge/gateway/run-authorization";
import { type ToolTokenClaims, verifyToolToken } from "../knowledge/gateway/token";
import { getRunForOrg } from "../runs/repo";
import { bearerToken } from "./link";
import { getRunnerPolicy, localRunnersEnabled } from "./policy";
import { runnerRegistry } from "./registry";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Bytes a bridge stream may hold in either direction; more resets the stream. */
export const MAX_BRIDGE_QUEUE_BYTES = 8 * 1024 * 1024;
const DRAIN_POLL_MS = 5;
/** How often an open stream's capability is checked again (run still running, local execution still allowed). */
const RECHECK_MS = 15_000;

/** What a run's tools do inside their own container. Inventory, lifecycle, terminals and ports stay with the backend. */
export const BRIDGE_METHODS: ReadonlySet<string> = new Set([
  "sandbox.get",
  "process.execute",
  "session.create",
  "session.delete",
  "session.get",
  "session.list",
  "session.command",
  "session.execute",
  "session.logs",
  "session.input",
  "fs.details",
]);
export const BRIDGE_STREAMS: ReadonlySet<string> = new Set(["file.read", "file.write", "logs.follow"]);

export type BridgeControl =
  | { readonly t: "opened"; readonly window?: number }
  | { readonly t: "credit"; readonly bytes: number }
  | { readonly t: "refused"; readonly code: string; readonly message: string }
  | { readonly t: "end" }
  | { readonly t: "reset"; readonly reason: string };

export function parseBridgeControl(text: string): BridgeControl | null {
  try {
    const value = JSON.parse(text) as { t?: unknown; code?: unknown; message?: unknown; reason?: unknown; window?: unknown; bytes?: unknown };
    switch (value.t) {
      case "opened":
        return Number.isSafeInteger(value.window) && (value.window as number) > 0 ? { t: "opened", window: value.window as number } : { t: "opened" };
      case "credit":
        return Number.isSafeInteger(value.bytes) && (value.bytes as number) > 0 ? { t: "credit", bytes: value.bytes as number } : null;
      case "end":
        return { t: "end" };
      case "refused":
        return typeof value.code === "string" && typeof value.message === "string" ? { t: "refused", code: value.code, message: value.message } : null;
      case "reset":
        return typeof value.reason === "string" ? { t: "reset", reason: value.reason } : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export interface BridgeRun {
  readonly id: string;
  readonly orgId: string | null;
  readonly sandboxId: string | null;
}

export interface RunnerBridgeDeps {
  readonly directory: SandboxLinkDirectory;
  readonly verify: (token: string | null) => ToolTokenClaims | null;
  /** The identity a capability authorizes right now: null unless its run is running (run-authorization). */
  readonly identity: (claims: ToolTokenClaims) => Promise<ToolTokenClaims | null>;
  readonly run: (orgId: string, runId: string) => Promise<BridgeRun | null>;
  readonly policy: (orgId: string) => Promise<{ readonly allowLocalExecution: boolean }>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly recheckMs?: number;
}

interface Grant {
  readonly runnerId: string;
  readonly containerId: string;
}

/**
 * The one container a capability may reach: the local sandbox recorded on its
 * run, on the runner it names, while the run is running and local execution
 * is allowed by the same switches the binding applies.
 */
async function grantFor(deps: RunnerBridgeDeps, header: string | undefined, runnerId: string): Promise<Grant | { readonly status: 401 | 403; readonly error: string }> {
  const claims = deps.verify(bearerToken(header));
  if (!claims) return { status: 401, error: "unauthorized" };
  const current = await deps.identity(claims).catch(() => null);
  if (!current) return { status: 403, error: "inactive_capability" };
  const run = await deps.run(current.orgId, current.runId).catch(() => null);
  if (!run || run.orgId !== current.orgId) return { status: 403, error: "inactive_capability" };
  const parsed = run.sandboxId ? parseLocalSandboxId(run.sandboxId) : null;
  if (!parsed || parsed.runnerId !== runnerId) return { status: 403, error: "sandbox_not_on_runner" };
  const link = deps.directory.get(runnerId);
  if (!link || link.orgId !== current.orgId) return { status: 403, error: "runner_not_in_organisation" };
  if (!localRunnersEnabled(deps.env) || !(await deps.policy(current.orgId).catch(() => ({ allowLocalExecution: false }))).allowLocalExecution) {
    return { status: 403, error: "local_execution_disabled" };
  }
  return { runnerId, containerId: parsed.containerId };
}

function targetsContainer(value: unknown, containerId: string): boolean {
  return typeof value === "object" && value !== null && (value as { sandboxId?: unknown }).sandboxId === containerId;
}

function streamKind(target: unknown): string | null {
  const kind = typeof target === "object" && target !== null ? (target as { kind?: unknown }).kind : null;
  return typeof kind === "string" ? kind : null;
}

/** Wait until the socket has sent what it holds, so a slow gateway cannot pile the sandbox's output up here. */
async function drained(raw: ServerWebSocket<unknown> | undefined): Promise<void> {
  while (raw && raw.readyState === 1 && raw.getBufferedAmount() > MAX_BRIDGE_QUEUE_BYTES) await Bun.sleep(DRAIN_POLL_MS);
}

export function createRunnerBridgeRoutes(deps: RunnerBridgeDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post("/bridge/call", async (c) => {
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return c.json({ error: "request_too_large" }, 413);
    let body: { runnerId?: unknown; method?: unknown; params?: unknown; timeoutMs?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (typeof body.runnerId !== "string" || typeof body.method !== "string") return c.json({ error: "invalid_request" }, 400);
    const grant = await grantFor(deps, c.req.header("authorization"), body.runnerId);
    if ("status" in grant) return c.json({ error: grant.error }, grant.status);
    if (!BRIDGE_METHODS.has(body.method)) return c.json({ error: "method_not_bridged" }, 403);
    if (!targetsContainer(body.params, grant.containerId)) return c.json({ error: "sandbox_not_granted" }, 403);
    const link = deps.directory.get(grant.runnerId)!;
    const timeoutMs = typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? Math.min(body.timeoutMs, 3_600_000) : undefined;
    try {
      const result = await link.call(body.method, body.params, timeoutMs === undefined ? undefined : { timeoutMs });
      return c.json({ result: result ?? null });
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "internal";
      return c.json({ error: { code, message: error instanceof Error ? error.message : String(error) } }, 502);
    }
  });

  routes.get(
    "/bridge/stream",
    upgradeWebSocket((c) => {
      const runnerId = c.req.query("runnerId") ?? "";
      let target: unknown = null;
      try {
        target = JSON.parse(Buffer.from(c.req.query("target") ?? "", "base64url").toString("utf8"));
      } catch {
        target = null;
      }
      const authorization = c.req.header("authorization");
      const grantPromise = grantFor(deps, authorization, runnerId);
      let stream: SandboxLinkStream | null = null;
      /** The gateway half-closed: no more bytes will arrive. */
      let ended = false;
      /** Why nothing more may flow, once a reset, an overflow or the socket closing ended the stream. */
      let terminated: string | null = null;
      /** Whether the stream settled, so a later socket close is not a failure. */
      let settled = false;
      /** Bytes accepted from the socket and not yet written into the stream. */
      let queued = 0;
      const inbound: Uint8Array[] = [];
      let writer: Promise<void> = Promise.resolve();
      let closing = false;
      let recheck: ReturnType<typeof setInterval> | null = null;
      let ws: WSContext<ServerWebSocket<unknown>> | null = null;
      const stopRecheck = () => {
        if (recheck) clearInterval(recheck);
        recheck = null;
      };
      const send = (payload: string | Uint8Array<ArrayBuffer>) => {
        try {
          ws?.send(payload);
        } catch {
          /* already closed */
        }
      };
      // Send the last frame, then close on the next tick so it leaves before the close does.
      const finish = (code: number, reason: string, control?: BridgeControl) => {
        if (closing) return;
        closing = true;
        stopRecheck();
        if (control) send(JSON.stringify(control));
        setTimeout(() => {
          try {
            ws?.close(code, reason.slice(0, 120));
          } catch {
            /* already closed */
          }
        }, 0);
      };
      const refuse = (code: string, message: string) => finish(1008, message, { t: "refused", code, message });
      /** End the stream from this side: the sandbox's stream is reset and the gateway is told why. */
      const terminate = (reason: string) => {
        if (terminated) return;
        terminated = reason;
        inbound.length = 0;
        queued = 0;
        stream?.reset(reason);
        finish(1011, reason, { t: "reset", reason });
      };
      // Writes keep their order; each one that lands returns its bytes as credit, one that fails ends the stream.
      const write = (opened: SandboxLinkStream, bytes: Uint8Array) => {
        writer = writer
          .then(() => opened.write(bytes))
          .then(
            () => {
              queued -= bytes.byteLength;
              if (!terminated) send(JSON.stringify({ t: "credit", bytes: bytes.byteLength } satisfies BridgeControl));
            },
            (error: unknown) => {
              queued -= bytes.byteLength;
              terminate(`write failed: ${error instanceof Error ? error.message : String(error)}`);
            },
          );
      };
      return {
        onOpen: (_event, socket) => {
          ws = socket;
          const raw = socket.raw;
          void grantPromise
            .then(async (grant) => {
              if ("status" in grant) return refuse(grant.error, grant.error);
              const kind = streamKind(target);
              if (!kind || !BRIDGE_STREAMS.has(kind)) return refuse("stream_not_bridged", "this stream kind is not served through the bridge");
              if (!targetsContainer(target, grant.containerId)) return refuse("sandbox_not_granted", "the target is not this capability's sandbox");
              const link = deps.directory.get(grant.runnerId)!;
              let opened: SandboxLinkStream;
              try {
                opened = await link.openStream(target);
              } catch (error) {
                const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "refused";
                return refuse(code, error instanceof Error ? error.message : String(error));
              }
              // The gateway reset or went away while the sandbox was opening: nothing it queued may reach the sandbox.
              if (terminated) return opened.reset(terminated);
              stream = opened;
              send(JSON.stringify({ t: "opened", window: MAX_BRIDGE_QUEUE_BYTES } satisfies BridgeControl));
              // A run that stops, or an administrator switching local execution off, ends open streams too.
              recheck = setInterval(() => {
                void grantFor(deps, authorization, runnerId).then(
                  (again) => {
                    if ("status" in again) terminate(`capability no longer valid: ${again.error}`);
                    else if (again.containerId !== grant.containerId) terminate("capability no longer names this sandbox");
                  },
                  () => terminate("capability could not be checked again"),
                );
              }, deps.recheckMs ?? RECHECK_MS);
              for (const chunk of inbound.splice(0)) write(opened, chunk);
              if (ended) writer = writer.then(() => opened.end()).catch(() => {});
              const reading = (async () => {
                try {
                  for await (const chunk of opened.readable) {
                    if (terminated) return;
                    send(new Uint8Array(chunk));
                    await drained(raw);
                  }
                  if (!terminated) send(JSON.stringify({ t: "end" } satisfies BridgeControl));
                } catch (error) {
                  terminate(error instanceof Error ? error.message : String(error));
                }
              })();
              // Close only after the last byte and the end frame went out; a failure after the
              // sandbox's side ended still reaches the gateway as a reset.
              void opened.done.then(
                async () => {
                  await reading;
                  settled = true;
                  if (!terminated) finish(1000, "stream done");
                },
                async (error: unknown) => {
                  await reading;
                  settled = true;
                  terminate(error instanceof Error ? error.message : String(error));
                },
              );
            })
            .catch((error: unknown) => refuse("internal", error instanceof Error ? error.message : String(error)));
        },
        onMessage: (event) => {
          if (terminated) return;
          const data = event.data;
          if (typeof data === "string") {
            const control = parseBridgeControl(data);
            if (control?.t === "end") {
              ended = true;
              if (stream) {
                const opened = stream;
                writer = writer.then(() => opened.end()).catch(() => {});
              }
            } else if (control?.t === "reset") {
              terminated = control.reason;
              inbound.length = 0;
              queued = 0;
              stream?.reset(control.reason);
            }
            return;
          }
          const bytes = data instanceof Blob ? null : new Uint8Array(data as ArrayBufferLike);
          if (!bytes) return;
          queued += bytes.byteLength;
          if (queued > MAX_BRIDGE_QUEUE_BYTES) return terminate("the bridge holds more than it may queue for the sandbox");
          if (stream) write(stream, bytes);
          else inbound.push(bytes);
        },
        onClose: () => {
          stopRecheck();
          if (settled || terminated) return;
          terminated = "bridge closed";
          inbound.length = 0;
          queued = 0;
          stream?.reset(terminated);
        },
        onError: () => {
          stopRecheck();
          if (settled || terminated) return;
          terminated = "bridge errored";
          inbound.length = 0;
          queued = 0;
          stream?.reset(terminated);
        },
      };
    }),
  );
  return routes;
}

export const runnerBridgeRoutes = createRunnerBridgeRoutes({
  directory: runnerRegistry.directory,
  verify: (token) => verifyToolToken(token),
  identity: resolveToolRunIdentity,
  run: async (orgId, runId) => {
    const run = await getRunForOrg(orgId, runId);
    return run ? { id: run.id, orgId: run.orgId, sandboxId: run.sandboxId } : null;
  },
  policy: getRunnerPolicy,
});
