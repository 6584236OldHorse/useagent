// The runner's WebSocket: `/api/internal/runners/link`. The runner token in
// the Authorization header names the runner; the first frame must be hello,
// answered with welcome once the token has resolved. Close codes 4401 (token
// rejected or revoked) and 4426 (runner too old) tell the runner not to retry.

import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { type HelloFrame, type ImagePullCredential, Mux, PROTOCOL_VERSION, type WelcomeFrame } from "@useagent/runner-protocol";
import type { AppEnv } from "../http";
import { currentReleaseFingerprint } from "../release";
import { runnerConfigBlock } from "./policy";
import { createPullCredentialSource } from "./registry-pull";
import { type RunnerRegistry, runnerRegistry } from "./registry";
import { type RunnerRow, runnerForToken } from "./store";

export const CLOSE_TOKEN_REJECTED = 4401;
export const CLOSE_RUNNER_TOO_OLD = 4426;
export const CLOSE_PROTOCOL_ERROR = 4400;
export const CLOSE_PLANE_ERROR = 1011;
export const HEARTBEAT_SECONDS = 15;
/** A link that says nothing after the socket opens is dropped. */
export const HELLO_TIMEOUT_MS = 15_000;

export interface RunnerLinkDeps {
  readonly registry: RunnerRegistry;
  readonly runnerForToken: (token: string) => Promise<RunnerRow | null>;
  readonly config: () => ReturnType<typeof runnerConfigBlock>;
  readonly release: () => string;
  /** The login a runner needs to pull the image, when the registry is private. */
  readonly pullCredential?: (ref: string) => Promise<ImagePullCredential | null>;
  readonly helloTimeoutMs?: number;
  readonly log?: (message: string) => void;
}

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match?.[1] ?? null;
}

export function welcomeFor(
  config: ReturnType<typeof runnerConfigBlock>,
  release: string,
  pull: ImagePullCredential | null = null,
): WelcomeFrame | null {
  if (!config.enabled || !config.image) return null;
  return {
    t: "welcome",
    protocol: PROTOCOL_VERSION,
    minProtocol: config.minProtocol,
    image: pull ? { ...config.image, pull } : config.image,
    heartbeatSeconds: HEARTBEAT_SECONDS,
    release,
  };
}

type Socket = { send(message: string | Uint8Array<ArrayBuffer>): void; close(code?: number, reason?: string): void };

export function createRunnerLinkRoutes(deps: RunnerLinkDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const log = deps.log ?? ((message: string) => console.warn(message));
  routes.get(
    "/link",
    upgradeWebSocket((c) => {
      // The token resolves while the socket opens; the mux exists from the first
      // byte, so a hello that races the lookup waits for it instead of being lost.
      const token = bearerToken(c.req.header("authorization"));
      const runnerPromise: Promise<RunnerRow | null> = (token ? deps.runnerForToken(token) : Promise.resolve(null)).catch((error: unknown) => {
        log(`[runners] token lookup failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      let socket: Socket | null = null;
      let runner: RunnerRow | null = null;
      let attached = false;
      let finished = false;
      let helloTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (code: number, reason: string) => {
        if (finished) return;
        finished = true;
        if (helloTimer) clearTimeout(helloTimer);
        try {
          socket?.close(code, reason);
        } catch {
          /* already closed */
        }
      };
      const mux = new Mux(
        "plane",
        {
          send: (message) => {
            socket?.send(typeof message === "string" ? message : message.slice());
          },
        },
        {
          onHello: (hello) => {
            void handleHello(hello).catch((error: unknown) => {
              log(`[runners] hello failed: ${error instanceof Error ? error.message : String(error)}`);
              finish(CLOSE_PLANE_ERROR, "the control plane could not attach the runner");
            });
          },
          onHeartbeat: (frame) => {
            if (!runner || !attached) return;
            void deps.registry.heartbeat(runner.id, mux, frame).then(
              (alive) => {
                if (!alive) finish(CLOSE_TOKEN_REJECTED, "runner revoked");
              },
              (error: unknown) => log(`[runners] heartbeat failed: ${error instanceof Error ? error.message : String(error)}`),
            );
          },
        },
      );
      const handleHello = async (hello: HelloFrame) => {
        if (attached || finished) return;
        const row = await runnerPromise;
        if (!row) {
          finish(CLOSE_TOKEN_REJECTED, "runner token rejected");
          return;
        }
        if (hello.runnerId !== row.id) {
          finish(CLOSE_PROTOCOL_ERROR, "hello names another runner");
          return;
        }
        const config = deps.config();
        if (hello.protocol < config.minProtocol) {
          finish(CLOSE_RUNNER_TOO_OLD, `the control plane needs protocol ${config.minProtocol}`);
          return;
        }
        const pull = config.image && deps.pullCredential ? await deps.pullCredential(config.image.ref) : null;
        if (finished) return;
        const welcome = welcomeFor(config, deps.release(), pull);
        if (!welcome) {
          finish(1013, config.enabled ? "no native image is configured for local sandboxes" : "local runners are switched off");
          return;
        }
        const live = await deps.registry.attach(row, mux, hello, { close: (code, reason) => finish(code, reason) });
        if (!live || finished) {
          if (!finished) finish(CLOSE_TOKEN_REJECTED, "runner revoked");
          return;
        }
        runner = row;
        attached = true;
        if (helloTimer) clearTimeout(helloTimer);
        mux.send(welcome);
      };
      const detach = (reason: string) => {
        if (runner && attached) {
          void deps.registry.detach(runner.id, mux, reason).catch((error: unknown) => {
            log(`[runners] detach failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        } else {
          mux.close(reason);
        }
      };
      return {
        onOpen: (_event, ws) => {
          socket = ws as unknown as Socket;
          helloTimer = setTimeout(() => {
            if (!attached) finish(CLOSE_PROTOCOL_ERROR, "no hello");
          }, deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
          void runnerPromise.then((row) => {
            if (!row) finish(CLOSE_TOKEN_REJECTED, "runner token rejected");
          });
        },
        onMessage: (event) => {
          const data = event.data;
          if (typeof data === "string") mux.receive(data);
          else if (data instanceof Blob) void data.arrayBuffer().then((buffer) => mux.receive(buffer)).catch(() => {});
          else mux.receive(new Uint8Array(data as ArrayBufferLike));
        },
        onClose: (event) => {
          finished = true;
          if (helloTimer) clearTimeout(helloTimer);
          detach(`link closed (${event.code})`);
        },
        onError: () => {
          finished = true;
          if (helloTimer) clearTimeout(helloTimer);
          detach("link errored");
        },
      };
    }),
  );
  return routes;
}

const pullCredentials = createPullCredentialSource(process.env);

export const runnerLinkRoutes = createRunnerLinkRoutes({
  registry: runnerRegistry,
  runnerForToken,
  config: () => runnerConfigBlock(),
  release: () => currentReleaseFingerprint().fingerprint,
  pullCredential: (ref) => pullCredentials.for(ref),
});
