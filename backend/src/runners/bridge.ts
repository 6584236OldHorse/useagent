// The bridge from the tool gateway to a runner's link. The gateway runs as a
// separate process with no links of its own; its sandbox-bound tools reach a
// machine through these routes on the backend, authenticated by the same
// signed capability the GitHub bridge uses. A capability reaches exactly one
// container: the one recorded on its run.
//
//   POST /bridge/call            {runnerId, method, params, timeoutMs} -> {result} | {error:{code,message}}
//   GET  /bridge/stream (ws)     ?runnerId=&target=<base64 json>; binary frames carry bytes,
//                                text frames carry {t:"opened"|"refused"|"end"|"reset"}

import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { parseLocalSandboxId } from "@useagent/runner-protocol";
import type { SandboxLinkDirectory, SandboxLinkStream } from "@useagent/sandbox-contract";
import type { AppEnv } from "../http";
import { type ToolTokenClaims, verifyToolToken } from "../knowledge/gateway/token";
import { getRunForOrg } from "../runs/repo";
import { bearerToken } from "./link";
import { runnerRegistry } from "./registry";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export type BridgeControl =
  | { readonly t: "opened" }
  | { readonly t: "refused"; readonly code: string; readonly message: string }
  | { readonly t: "end" }
  | { readonly t: "reset"; readonly reason: string };

export function parseBridgeControl(text: string): BridgeControl | null {
  try {
    const value = JSON.parse(text) as { t?: unknown; code?: unknown; message?: unknown; reason?: unknown };
    switch (value.t) {
      case "opened":
      case "end":
        return { t: value.t };
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
  readonly run: (orgId: string, runId: string) => Promise<BridgeRun | null>;
}

interface Grant {
  readonly runnerId: string;
  readonly containerId: string;
}

/** The one container a capability may reach: the local sandbox recorded on its run, on the runner it names. */
async function grantFor(deps: RunnerBridgeDeps, header: string | undefined, runnerId: string): Promise<Grant | { readonly status: 401 | 403; readonly error: string }> {
  const claims = deps.verify(bearerToken(header));
  if (!claims) return { status: 401, error: "unauthorized" };
  const run = claims.runId ? await deps.run(claims.orgId, claims.runId).catch(() => null) : null;
  if (!run || run.orgId !== claims.orgId) return { status: 403, error: "inactive_capability" };
  const parsed = run.sandboxId ? parseLocalSandboxId(run.sandboxId) : null;
  if (!parsed || parsed.runnerId !== runnerId) return { status: 403, error: "sandbox_not_on_runner" };
  const link = deps.directory.get(runnerId);
  if (!link || link.orgId !== claims.orgId) return { status: 403, error: "runner_not_in_organisation" };
  return { runnerId, containerId: parsed.containerId };
}

function targetsContainer(value: unknown, containerId: string): boolean {
  return typeof value === "object" && value !== null && (value as { sandboxId?: unknown }).sandboxId === containerId;
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
    // Every method the gateway needs names the container; list would cross containers.
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
      const grantPromise = grantFor(deps, c.req.header("authorization"), runnerId);
      let stream: SandboxLinkStream | null = null;
      let ended = false;
      const inbound: Uint8Array[] = [];
      let writer: Promise<void> = Promise.resolve();
      return {
        onOpen: (_event, ws) => {
          // Send the reason, then close on the next tick so the frame leaves before the close does.
          const refuse = (code: string, message: string) => {
            try {
              ws.send(JSON.stringify({ t: "refused", code, message } satisfies BridgeControl));
            } catch {
              /* already closed */
            }
            setTimeout(() => {
              try {
                ws.close(1008, message.slice(0, 120));
              } catch {
                /* already closed */
              }
            }, 0);
          };
          void grantPromise.then(async (grant) => {
            if ("status" in grant) return refuse(grant.error, grant.error);
            if (!targetsContainer(target, grant.containerId)) return refuse("sandbox_not_granted", "the target is not this capability's sandbox");
            const link = deps.directory.get(grant.runnerId)!;
            let opened: SandboxLinkStream;
            try {
              opened = await link.openStream(target);
            } catch (error) {
              const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "refused";
              return refuse(code, error instanceof Error ? error.message : String(error));
            }
            stream = opened;
            ws.send(JSON.stringify({ t: "opened" } satisfies BridgeControl));
            // Bytes queued before the stream existed go first, in order.
            for (const chunk of inbound.splice(0)) writer = writer.then(() => opened.write(chunk)).catch(() => {});
            if (ended) writer = writer.then(() => opened.end());
            const reading = (async () => {
              try {
                for await (const chunk of opened.readable) ws.send(chunk.slice());
                ws.send(JSON.stringify({ t: "end" } satisfies BridgeControl));
              } catch (error) {
                try {
                  ws.send(JSON.stringify({ t: "reset", reason: error instanceof Error ? error.message : String(error) } satisfies BridgeControl));
                } catch {
                  /* already closed */
                }
                setTimeout(() => {
                  try {
                    ws.close(1011, "stream reset");
                  } catch {
                    /* already closed */
                  }
                }, 0);
              }
            })();
            // Close only after the last byte and the end frame went out.
            void opened.done.then(
              async () => {
                await reading;
                try {
                  ws.close(1000, "stream done");
                } catch {
                  /* already closed */
                }
              },
              () => {},
            );
          }).catch((error: unknown) => refuse("internal", error instanceof Error ? error.message : String(error)));
        },
        onMessage: (event) => {
          const data = event.data;
          if (typeof data === "string") {
            const control = parseBridgeControl(data);
            if (control?.t === "end") {
              ended = true;
              if (stream) writer = writer.then(() => stream?.end()).catch(() => {});
            } else if (control?.t === "reset") {
              stream?.reset(control.reason);
            }
            return;
          }
          const bytes = data instanceof Blob ? null : new Uint8Array(data as ArrayBufferLike);
          if (!bytes) return;
          if (stream) writer = writer.then(() => stream!.write(bytes)).catch(() => {});
          else inbound.push(bytes);
        },
        onClose: () => {
          if (stream && !ended) stream.reset("bridge closed");
        },
        onError: () => {
          stream?.reset("bridge errored");
        },
      };
    }),
  );
  return routes;
}

export const runnerBridgeRoutes = createRunnerBridgeRoutes({
  directory: runnerRegistry.directory,
  verify: (token) => verifyToolToken(token),
  run: async (orgId, runId) => {
    const run = await getRunForOrg(orgId, runId);
    return run ? { id: run.id, orgId: run.orgId, sandboxId: run.sandboxId } : null;
  },
});
