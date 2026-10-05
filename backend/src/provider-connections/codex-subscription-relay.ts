import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { env } from "../env";
import type { AppEnv } from "../http";
import { codexAppServerChildEnvironment } from "./codex-app-server";
import type { ToolGatewayCapabilityDescriptor } from "../knowledge/gateway/descriptor";
import {
  getCodexSubscriptionRuntimeSelection,
  type CodexSubscriptionRuntimeSelection,
} from "./service";
import { bindProviderThread, findProviderThreadBinding } from "./repo";
import { CodexSubscriptionProtocol, parseCodexSubscriptionFrame } from "./codex-subscription-protocol";
import { createCodexRemoteEnvironmentBootstrap } from "./codex-remote-environment-bootstrap";
import { createSerialTaskQueue } from "./serial-task-queue";
import {
  attachCodexSubscriptionAppServer,
  startCodexSubscriptionAppServer,
  suppressCodexSubscriptionStartupRejection,
} from "./codex-subscription-app-server";
import { errorMessage } from "../util/error-message";
import { prepareCodexServerFrame } from "./codex-native-output";
import { importCodexNativeOutput } from "./codex-native-output-import";

const DEFAULT_CAPABILITY_TTL_MS = 2 * 60_000;
// One run may start its turn and the plane's one continuation of it; anything
// more is not the plane speaking.
const MAX_TURN_STARTS_PER_RUN = 2;
const MAX_REMEMBERED_TURNS = 64;
const RELAY_PATH_PREFIX = "/api/internal/codex-relay/";
const CODEX_PLAN_TOOL_OVERRIDE = "tools.update_plan.enabled=true";
// This app-server runs on the backend host. Every default-on feature that could
// start a process, browser or plugin here stays off; shell and file tools reach
// the sandbox through the run's remote environment. ChatGPT Apps (codex_apps)
// are not part of the product's tool surface either, and every turn waited on
// their startup. Model-written code-mode JavaScript runs in the sandbox's
// code-mode host (see codexSubscriptionAppServerArgs).
const HOST_EXECUTION_FEATURES_OFF = [
  "apps", "plugins", "remote_plugin", "plugin_sharing", "tool_suggest", "skill_mcp_dependency_install",
  "hooks", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use",
  "in_app_browser", "in_app_local_automation", "shell_snapshot",
].flatMap((feature) => ["-c", `features.${feature}=false`]);

export interface CodexSubscriptionRelayBinding {
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly connectionId: string;
  readonly authEpoch: string;
  readonly model: string;
  readonly sandboxId: string;
  readonly sandboxGeneration: string;
  readonly environmentId: string;
  readonly cwd: string;
}

/** What a relay session is bound to for its whole life; the run and its model change per turn. */
export type CodexRelaySessionScope = Omit<CodexSubscriptionRelayBinding, "runId" | "model">;

/** The run a relay session serves until it is deactivated. */
export interface CodexRelayRun {
  readonly runId: string;
  readonly model: string;
  /** This run's tool-gateway bearer, handed to the app-server's MCP client per connection. */
  readonly toolGatewayBearer: string | null;
}

export interface CodexSubscriptionRelayCapability {
  readonly url: string;
  close(): void;
}

/** A relay endpoint the sandbox's runtime dials. Reusable sessions outlive their
 * runs and accept a new connection after the last one closed; single-use ones
 * accept exactly one connection, within the capability window. */
export interface CodexRelaySession extends CodexSubscriptionRelayCapability {
  /** Serve `run` from now on: its model, its gateway bearer. */
  activate(run: CodexRelayRun): void;
  /** Serve no run: turn starts are refused and the gateway bearer is withdrawn. */
  deactivate(): void;
  /** Whether a runtime connection is open on this session right now. */
  readonly connected: boolean;
  readonly closed: boolean;
}

export function codexSubscriptionRelayPublicOrigin(
  source: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = source.CODEX_SUBSCRIPTION_RELAY_PUBLIC_ORIGIN?.trim();
  const origin = new URL(configured || env.BETTER_AUTH_URL);
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("CODEX_SUBSCRIPTION_RELAY_PUBLIC_ORIGIN must be an HTTP(S) origin");
  }
  return origin.origin;
}

/** The MCP server the app-server reaches the tool gateway through. Its bearer is
 * read per connection from `headersFile`, rewritten at every run activation. */
export interface RelayToolGateway {
  readonly serverName: string;
  readonly url: string;
  readonly headersFile: string;
}

interface RelaySessionState {
  readonly scope: CodexRelaySessionScope;
  readonly codexHome: string;
  readonly execServerUrl: string;
  readonly codeModeHostUrl: string;
  readonly toolGateway: RelayToolGateway | null;
  readonly reusable: boolean;
  readonly expiresAt: number;
  connections: number;
  live: boolean;
  closed: boolean;
  run: (CodexRelayRun & { turnStarts: number }) | null;
  /** Provider turn id -> the run that started it, for attributing native output. */
  readonly turnRuns: Map<string, string>;
  /** Ends the live connection and its app-server; set while one is open. */
  disconnect: (() => void) | null;
}

interface RelayDependencies {
  readonly now: () => number;
  readonly selectRuntime: typeof getCodexSubscriptionRuntimeSelection;
  readonly spawnAppServer: (input: {
    readonly codexHome: string;
    readonly execServerUrl: string;
    readonly codeModeHostUrl: string;
    readonly toolGateway: RelayToolGateway | null;
  }) => ChildProcessWithoutNullStreams;
  readonly loadThreadBinding: (scope: CodexRelaySessionScope) => Promise<string | null>;
  readonly bindThread: (
    scope: CodexRelaySessionScope & { readonly providerThreadId: string },
  ) => Promise<void>;
  /** Where a session's MCP headers file lives (private to the backend). */
  readonly headersDirectory: (codexHome: string) => string;
}

const sessions = new Map<string, RelaySessionState>();

/** The app-server's arguments. Model-written code-mode JavaScript runs in the
 * sandbox's code-mode host at `codeModeHostUrl` (a loopback tunnel), never in a
 * host process this backend would otherwise start. The tool gateway's bearer is
 * never in the arguments or environment: a helper prints it per connection. */
export function codexSubscriptionAppServerArgs(
  toolGateway: RelayToolGateway | null,
  codeModeHostUrl: string,
): string[] {
  assertLoopbackUrl(codeModeHostUrl, ["http:"], "Codex code-mode host must be a loopback HTTP tunnel");
  if (toolGateway && /\s/.test(toolGateway.headersFile)) {
    throw new Error("Codex tool gateway headers path must not contain whitespace");
  }
  return [
    "app-server",
    "--stdio",
    "--code-mode-host",
    codeModeHostUrl,
    "-c",
    CODEX_PLAN_TOOL_OVERRIDE,
    ...HOST_EXECUTION_FEATURES_OFF,
    ...(toolGateway
      ? [
          "-c",
          `mcp_servers.${toolGateway.serverName}.url=${JSON.stringify(toolGateway.url)}`,
          "-c",
          `mcp_servers.${toolGateway.serverName}.http_headers_helper=${JSON.stringify(`/bin/cat ${toolGateway.headersFile}`)}`,
        ]
      : []),
  ];
}

const defaultDependencies: RelayDependencies = {
  now: Date.now,
  selectRuntime: getCodexSubscriptionRuntimeSelection,
  spawnAppServer: ({ codexHome, toolGateway, codeModeHostUrl }) =>
    spawn("codex", codexSubscriptionAppServerArgs(toolGateway, codeModeHostUrl), {
      env: codexAppServerChildEnvironment(codexHome),
      stdio: ["pipe", "pipe", "pipe"],
    }),
  loadThreadBinding: (scope) => findProviderThreadBinding(threadBindingScope(scope)),
  bindThread: (scope) => bindProviderThread({
    ...threadBindingScope(scope),
    providerThreadId: scope.providerThreadId,
  }),
  headersDirectory: (codexHome) => join(codexHome, "useagent-relay"),
};

let dependencies = defaultDependencies;

export function openCodexRelaySession(input: {
  readonly scope: CodexRelaySessionScope;
  readonly runtime: CodexSubscriptionRuntimeSelection;
  readonly execServerUrl: string;
  readonly codeModeHostUrl: string;
  readonly toolGateway: Pick<ToolGatewayCapabilityDescriptor, "serverName" | "url"> | null;
  readonly reusable: boolean;
  readonly ttlMs?: number;
  readonly publicOrigin?: string;
}): CodexRelaySession {
  pruneExpiredSessions(dependencies.now());
  assertLoopbackUrl(input.execServerUrl, ["ws:", "wss:"], "Codex app-server exec bridge must be a loopback websocket");
  assertLoopbackUrl(input.codeModeHostUrl, ["http:"], "Codex code-mode host must be a loopback HTTP tunnel");
  assertRuntimeMatchesBinding(input.runtime, input.scope);
  const token = crypto.randomUUID();
  const key = capabilityKey(token);
  let toolGateway: RelayToolGateway | null = null;
  if (input.toolGateway) {
    const directory = dependencies.headersDirectory(input.runtime.codexHome);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    toolGateway = { serverName: input.toolGateway.serverName, url: input.toolGateway.url, headersFile: join(directory, `${key.slice(0, 32)}.json`) };
  }
  const state: RelaySessionState = {
    scope: structuredClone(input.scope),
    codexHome: input.runtime.codexHome,
    execServerUrl: input.execServerUrl,
    codeModeHostUrl: input.codeModeHostUrl,
    toolGateway,
    reusable: input.reusable,
    expiresAt: dependencies.now() + (input.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS),
    connections: 0,
    live: false,
    closed: false,
    run: null,
    turnRuns: new Map(),
    disconnect: null,
  };
  writeGatewayHeaders(state, null);
  sessions.set(key, state);
  const origin = new URL(input.publicOrigin ?? codexSubscriptionRelayPublicOrigin());
  origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  origin.pathname = `${RELAY_PATH_PREFIX}${token}`;
  origin.search = "";
  origin.hash = "";

  return {
    url: origin.toString(),
    activate(run) {
      if (state.closed) throw new Error("Codex relay session is closed");
      state.run = { ...run, turnStarts: 0 };
      writeGatewayHeaders(state, run.toolGatewayBearer);
    },
    deactivate() {
      state.run = null;
      writeGatewayHeaders(state, null);
    },
    get connected() {
      return state.live;
    },
    get closed() {
      return state.closed;
    },
    close() {
      closeSession(key, state);
    },
  };
}

/** One run's single-use relay capability: the session dies with its connection. */
export function issueCodexSubscriptionRelayCapability(input: {
  readonly binding: CodexSubscriptionRelayBinding;
  readonly runtime: CodexSubscriptionRuntimeSelection;
  readonly execServerUrl: string;
  readonly codeModeHostUrl: string;
  readonly toolGateway?: ToolGatewayCapabilityDescriptor | null;
  readonly ttlMs?: number;
  readonly publicOrigin?: string;
}): CodexSubscriptionRelayCapability {
  const { runId, model, ...scope } = input.binding;
  const session = openCodexRelaySession({
    scope,
    runtime: input.runtime,
    execServerUrl: input.execServerUrl,
    codeModeHostUrl: input.codeModeHostUrl,
    toolGateway: input.toolGateway ?? null,
    reusable: false,
    ttlMs: input.ttlMs,
    publicOrigin: input.publicOrigin,
  });
  session.activate({ runId, model, toolGatewayBearer: input.toolGateway?.bearerToken ?? null });
  return { url: session.url, close: () => session.close() };
}

export const codexSubscriptionRelayRoutes = new Hono<AppEnv>();

codexSubscriptionRelayRoutes.get(
  "/:capability",
  upgradeWebSocket((context) => {
    pruneExpiredSessions(dependencies.now());
    const token = context.req.param("capability") ?? "";
    const key = capabilityKey(token);
    const session = sessions.get(key);
    const browserOrigin = context.req.header("origin");
    const accepted = Boolean(
      session && !session.closed && !browserOrigin && !session.live &&
        (session.reusable || session.connections === 0) &&
        (session.connections > 0 || session.expiresAt > dependencies.now()),
    );
    // Token-free relay visibility: the capability token is never logged; the runId
    // correlates the sandbox dial with the run. Explains whether the sandbox
    // reached the relay at all and why a capability was refused.
    const runLabel = () => session?.run?.runId ?? "none";
    const validation = accepted
      ? "accepted"
      : !session || session.closed
        ? "unknown-capability"
        : browserOrigin
          ? "rejected-browser-origin"
          : session.live || session.connections > 0
            ? "rejected-consumed"
            : "rejected-expired";
    console.log(`[codex-relay] capability ${validation}${session ? ` run=${runLabel()}` : ""}`);
    if (session && browserOrigin) closeSession(key, session);
    if (session && accepted) {
      session.connections += 1;
      session.live = true;
    }
    let child: ChildProcessWithoutNullStreams | null = null;
    let closed = false;
    const binding = (): CodexSubscriptionRelayBinding => {
      if (!session?.run) throw new Error("no run is active on this relay session");
      return { ...session.scope, runId: session.run.runId, model: session.run.model };
    };
    const protocol = session
      ? new CodexSubscriptionProtocol(binding, {
          loadThreadBinding: () => dependencies.loadThreadBinding(session.scope),
          bindThread: (providerThreadId) => dependencies.bindThread({
            ...session.scope,
            providerThreadId,
          }),
        })
      : null;
    const environmentBootstrap = session
      ? createCodexRemoteEnvironmentBootstrap({
          environmentId: session.scope.environmentId,
          execServerUrl: session.execServerUrl,
        })
      : null;
    const childReady = accepted && session
      ? startCodexSubscriptionAppServer({
          authorize: () => authorizeSession(session),
          isClosed: () => closed,
          spawn: () => dependencies.spawnAppServer({
            codexHome: session.codexHome,
            execServerUrl: session.execServerUrl,
            codeModeHostUrl: session.codeModeHostUrl,
            toolGateway: session.toolGateway,
          }),
          onSpawn: (process) => {
            child = process;
          },
        })
      : Promise.reject(new Error("invalid or expired capability"));
    // Invalid capabilities never await this promise. Attach a rejection
    // handler immediately so a rejected authorization cannot surface as an
    // unhandled process-level rejection before the socket open callback runs.
    void suppressCodexSubscriptionStartupRejection(childReady);

    const closeChild = () => {
      const active = child;
      child = null;
      if (!active || active.killed) return;
      active.kill("SIGTERM");
    };
    let relaySocket: { close(code?: number, reason?: string): void } | null = null;
    const rejectRelay = (error: unknown) => {
      // The rejection REASON must be visible in operations: a silent 1008 close
      // reads as "no first activity" at the run layer and hides the real cause
      // (binding mismatch, oversized frame, disconnected subscription). Frame
      // CONTENT is never logged - only the protocol error message.
      const reason = errorMessage(error);
      console.log(`[codex-relay] frame rejected run=${runLabel()}: ${reason}`);
      relaySocket?.close(1008, "relay frame rejected");
      relaySocket = null;
      closed = true;
      environmentBootstrap?.close();
      closeChild();
    };
    const clientFrames = createSerialTaskQueue(rejectRelay);
    const serverFrames = createSerialTaskQueue(rejectRelay);

    return {
      onOpen: (_event, socket) => {
        relaySocket = socket;
        if (!session || !accepted) {
          socket.close(1008, "invalid or expired capability");
          return;
        }
        console.log(`[codex-relay] connection open run=${runLabel()}`);
        session.disconnect = () => {
          socket.close(1001, "relay session closed");
          closed = true;
          environmentBootstrap?.close();
          closeChild();
        };
        void attachCodexSubscriptionAppServer({
          childReady,
          isClosed: () => closed,
          closeChild,
          onChildClosed: () => {
            child = null;
          },
          onLine: (line) => serverFrames.enqueue(async () => {
            await authorizeSession(session);
            if (!protocol || !environmentBootstrap) {
              throw new Error("Codex relay protocol is unavailable");
            }
            // The protocol is the account-wide thread boundary. It may hold an
            // out-of-order descendant until ancestry becomes provable, and it
            // never returns foreign thread frames. Sanitize each released frame
            // before any downstream consumer; host image locators exist only in
            // this serial host-side task.
            const ready = await protocol.observeServerFrame(line);
            for (const authorizedFrame of ready) {
              authorizedFrame.commit();
              rememberTurnRun(session, authorizedFrame.raw);
              const prepared = prepareCodexServerFrame(authorizedFrame.raw);
              // Native output belongs to the run whose turn produced it; output
              // of a turn this session did not see start is not attributed.
              const runId = prepared.image ? session.turnRuns.get(prepared.image.turnId) : undefined;
              if (prepared.image && runId) {
                await importCodexNativeOutput({
                  orgId: session.scope.orgId,
                  userId: session.scope.userId,
                  productThreadId: session.scope.threadId,
                  runId,
                  codexHome: session.codexHome,
                  candidate: prepared.image,
                  validateIdentity: (identity) => protocol.validateNativeOutputIdentity(identity),
                });
              }
              const forwarded = await environmentBootstrap.acceptServerFrame(prepared.frame);
              for (const frame of forwarded) socket.send(frame);
            }
          }),
          closeSocket: (code, reason) => socket.close(code, reason),
        });
      },
      onMessage: (event, socket) => {
        relaySocket = socket;
        if (!session || !accepted) return;
        const frame = typeof event.data === "string"
          ? event.data
          : Buffer.from(event.data as ArrayBuffer).toString("utf8");
        clientFrames.enqueue(async () => {
          const process = await childReady;
          await authorizeSession(session);
          if (!protocol || !environmentBootstrap) {
            throw new Error("Codex relay protocol is unavailable");
          }
          admitTurnStart(session, frame);
          // The protocol may rewrite the frame (bound-thread `thread/start`
          // becomes `thread/resume`); everything downstream sees the outbound.
          const outbound = await protocol.acceptClientFrame(frame);
          if (!process.stdin.writable) throw new Error("Codex app-server is unavailable");
          const forwarded = await environmentBootstrap.acceptClientFrame(outbound);
          for (const childFrame of forwarded) process.stdin.write(`${childFrame}\n`);
        });
      },
      onClose: () => {
        if (accepted) console.log(`[codex-relay] connection closed run=${runLabel()}`);
        closed = true;
        relaySocket = null;
        environmentBootstrap?.close();
        closeChild();
        if (session && accepted) {
          session.live = false;
          session.disconnect = null;
          if (!session.reusable) closeSession(key, session);
        }
      },
    };
  }),
);

/** Fail closed between runs: a turn starts only while a run is active, and a run
 * starts at most its turn and one continuation. */
function admitTurnStart(session: RelaySessionState, raw: string): void {
  if (parseCodexSubscriptionFrame(raw, "client").method !== "turn/start") return;
  if (!session.run) throw new Error("no run is active on this relay session");
  if (session.run.turnStarts >= MAX_TURN_STARTS_PER_RUN) {
    throw new Error("turn start limit for this run reached");
  }
  session.run.turnStarts += 1;
}

/** Remember which run a provider turn started under (bounded, oldest first out). */
function rememberTurnRun(session: RelaySessionState, raw: string): void {
  const frame = parseCodexSubscriptionFrame(raw);
  if (frame.method !== "turn/started" || !session.run) return;
  const turn = frame.params?.turn;
  const turnId = turn && typeof turn === "object" && !Array.isArray(turn)
    ? (turn as Record<string, unknown>).id
    : undefined;
  if (typeof turnId !== "string" || !turnId) return;
  session.turnRuns.set(turnId, session.run.runId);
  if (session.turnRuns.size > MAX_REMEMBERED_TURNS) {
    session.turnRuns.delete(session.turnRuns.keys().next().value!);
  }
}

/** The MCP client's headers for the active run (or none), written atomically
 * and readable by the backend user only. */
function writeGatewayHeaders(session: RelaySessionState, bearer: string | null): void {
  if (!session.toolGateway) return;
  const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};
  const temporary = `${session.toolGateway.headersFile}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(headers), { mode: 0o600 });
  renameSync(temporary, session.toolGateway.headersFile);
}

function closeSession(key: string, session: RelaySessionState): void {
  if (session.closed) return;
  session.closed = true;
  session.run = null;
  sessions.delete(key);
  session.disconnect?.();
  session.disconnect = null;
  try {
    writeGatewayHeaders(session, null);
  } catch {
    // A missing headers directory has nothing left to withdraw.
  }
}

async function authorizeSession(session: RelaySessionState): Promise<void> {
  const runtime = await dependencies.selectRuntime({
    orgId: session.scope.orgId,
    userId: session.scope.userId,
    provider: "openai",
  });
  if (!runtime) throw new Error("Codex subscription is disconnected");
  assertRuntimeMatchesBinding(runtime, session.scope);
}

function assertRuntimeMatchesBinding(
  runtime: CodexSubscriptionRuntimeSelection,
  binding: Pick<CodexSubscriptionRelayBinding, "connectionId" | "authEpoch">,
): void {
  if (
    runtime.connectionId !== binding.connectionId ||
    runtime.authEpoch !== binding.authEpoch
  ) {
    throw new Error("Codex subscription authorization changed");
  }
}

function threadBindingScope(scope: CodexRelaySessionScope) {
  return {
    orgId: scope.orgId,
    userId: scope.userId,
    productThreadId: scope.threadId,
    connectionId: scope.connectionId,
    authEpoch: scope.authEpoch,
  };
}

function capabilityKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A single-use session nobody dialed in time is gone; reusable ones live until closed. */
function pruneExpiredSessions(now: number): void {
  for (const [key, session] of sessions) {
    if (!session.reusable && session.connections === 0 && session.expiresAt <= now) closeSession(key, session);
  }
}

function assertLoopbackUrl(value: string, protocols: readonly string[], message: string): void {
  const url = new URL(value);
  if (
    !protocols.includes(url.protocol) ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1")
  ) {
    throw new Error(message);
  }
}

export function setCodexSubscriptionRelayDependenciesForTest(
  overrides: Partial<RelayDependencies> | null,
): void {
  dependencies = overrides ? { ...defaultDependencies, ...overrides } : defaultDependencies;
  for (const [key, session] of sessions) closeSession(key, session);
}
