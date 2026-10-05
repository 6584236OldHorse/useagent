// The runner's WebSocket: `/api/internal/runners/link`. Authenticated by the
// runner token in the Authorization header before the upgrade; after it, the
// first frame must be hello, answered with welcome. Close codes 4401 (token
// rejected) and 4426 (runner too old) tell the runner not to retry.

import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { type HelloFrame, Mux, PROTOCOL_VERSION, type WelcomeFrame } from "@useagent/runner-protocol";
import type { AppEnv } from "../http";
import { currentReleaseFingerprint } from "../release";
import { runnerConfigBlock } from "./policy";
import { type RunnerRegistry, runnerRegistry } from "./registry";
import { type RunnerRow, runnerForToken } from "./store";

export const CLOSE_TOKEN_REJECTED = 4401;
export const CLOSE_RUNNER_TOO_OLD = 4426;
export const CLOSE_PROTOCOL_ERROR = 4400;
export const HEARTBEAT_SECONDS = 15;

export interface RunnerLinkDeps {
  readonly registry: RunnerRegistry;
  readonly runnerForToken: (token: string) => Promise<RunnerRow | null>;
  readonly config: () => ReturnType<typeof runnerConfigBlock>;
  readonly release: () => string;
}

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match?.[1] ?? null;
}

export function welcomeFor(config: ReturnType<typeof runnerConfigBlock>, release: string): WelcomeFrame | null {
  if (!config.enabled || !config.image) return null;
  return {
    t: "welcome",
    protocol: PROTOCOL_VERSION,
    minProtocol: config.minProtocol,
    image: config.image,
    heartbeatSeconds: HEARTBEAT_SECONDS,
    release,
  };
}

export function createRunnerLinkRoutes(deps: RunnerLinkDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.get(
    "/link",
    upgradeWebSocket((c) => {
      // Resolve the token before the socket opens; the outcome decides the close code.
      const token = bearerToken(c.req.header("authorization"));
      const runnerPromise = token ? deps.runnerForToken(token) : Promise.resolve(null);
      let mux: Mux | null = null;
      let runner: RunnerRow | null = null;
      let attached = false;
      return {
        onOpen: (_event, ws) => {
          void runnerPromise.then(async (row) => {
            if (!row) {
              ws.close(CLOSE_TOKEN_REJECTED, "runner token rejected");
              return;
            }
            runner = row;
            const link = new Mux(
              "plane",
              {
                send: (message) => {
                  ws.send(typeof message === "string" ? message : message.slice());
                },
              },
              {
                onHello: (hello) => {
                  void handleHello(hello);
                },
                onHeartbeat: (frame) => {
                  if (runner && mux && attached) void deps.registry.heartbeat(runner.id, mux, frame);
                },
              },
            );
            mux = link;
            const handleHello = async (hello: HelloFrame) => {
              if (!runner || attached) return;
              if (hello.runnerId !== runner.id) {
                ws.close(CLOSE_PROTOCOL_ERROR, "hello names another runner");
                return;
              }
              const config = deps.config();
              if (hello.protocol < config.minProtocol) {
                ws.close(CLOSE_RUNNER_TOO_OLD, `the control plane needs protocol ${config.minProtocol}`);
                return;
              }
              const welcome = welcomeFor(config, deps.release());
              if (!welcome) {
                ws.close(1013, config.enabled ? "no native image is configured for local sandboxes" : "local runners are switched off");
                return;
              }
              attached = true;
              await deps.registry.attach(runner, link, hello);
              link.send(welcome);
            };
          });
        },
        onMessage: (event) => {
          const data = event.data;
          if (typeof data === "string") mux?.receive(data);
          else if (data instanceof Blob) void data.arrayBuffer().then((buffer) => mux?.receive(buffer));
          else mux?.receive(new Uint8Array(data as ArrayBufferLike));
        },
        onClose: (event) => {
          if (runner && mux) void deps.registry.detach(runner.id, mux, `link closed (${event.code})`);
          else mux?.close("link closed");
        },
        onError: () => {
          if (runner && mux) void deps.registry.detach(runner.id, mux, "link errored");
        },
      };
    }),
  );
  return routes;
}

export const runnerLinkRoutes = createRunnerLinkRoutes({
  registry: runnerRegistry,
  runnerForToken,
  config: () => runnerConfigBlock(),
  release: () => currentReleaseFingerprint().fingerprint,
});
