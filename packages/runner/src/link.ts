// The one outbound connection: WebSocket to the control plane, hello and
// welcome, heartbeats, reconnect with backoff. Every RPC and stream the plane
// sends is handed to the service. Nothing ever connects inward.

import {
  type HelloFrame,
  type ImageRef,
  Mux,
  type MuxStream,
  PROTOCOL_VERSION,
  type RunnerBackendKind,
  type RunnerCapacity,
  type WelcomeFrame,
} from "@useagent/runner-protocol";

export const LINK_PATH = "/api/internal/runners/link";
/** The oldest control plane protocol this runner can talk to. */
export const MIN_PLANE_PROTOCOL = 1;

/** Close codes the plane uses to end a link for good; the runner does not retry them. */
export const CLOSE_TOKEN_REJECTED = 4401;
export const CLOSE_RUNNER_TOO_OLD = 4426;

export type LinkStop =
  | { readonly reason: "token_rejected"; readonly detail: string }
  | { readonly reason: "runner_too_old"; readonly detail: string }
  | { readonly reason: "plane_too_old"; readonly detail: string }
  | { readonly reason: "stopped"; readonly detail: string };

export interface LinkOptions {
  readonly planeUrl: string;
  readonly token: string;
  readonly runnerId: string;
  readonly version: string;
  readonly backend: RunnerBackendKind;
  readonly platform: string;
  readonly capacity: () => RunnerCapacity;
  readonly logins: () => readonly string[];
  readonly imageDigest: () => string | null;
  readonly rpc: (method: string, params: unknown) => Promise<unknown>;
  readonly stream: (target: unknown, stream: MuxStream) => Promise<void> | void;
  /** The plane's answer to hello; the runner pulls the image it names before reporting online. */
  readonly onWelcome: (frame: WelcomeFrame) => Promise<void> | void;
  readonly onState: (state: "connecting" | "online" | "offline", detail: string) => void;
  readonly connect?: (url: string, headers: Record<string, string>) => WebSocket;
  readonly backoff?: { readonly initialMs: number; readonly maxMs: number };
  readonly sleep?: (ms: number) => Promise<void>;
}

export function linkUrl(planeUrl: string): string {
  const url = new URL(LINK_PATH, planeUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function helloFrame(options: LinkOptions): HelloFrame {
  return {
    t: "hello",
    runnerId: options.runnerId,
    version: options.version,
    protocol: PROTOCOL_VERSION,
    backend: options.backend,
    platform: options.platform,
    capacity: options.capacity(),
    logins: options.logins(),
    imageDigest: options.imageDigest(),
  };
}

export class LinkClient {
  private stopped: LinkStop | null = null;
  private socket: WebSocket | null = null;
  private mux: Mux | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private wake: (() => void) | null = null;
  image: ImageRef | null = null;

  constructor(private readonly options: LinkOptions) {}

  /** Runs until the plane ends the link for good or stop() is called. */
  async run(): Promise<LinkStop> {
    const backoff = this.options.backoff ?? { initialMs: 1000, maxMs: 30_000 };
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let delay = backoff.initialMs;
    while (!this.stopped) {
      this.options.onState("connecting", this.options.planeUrl);
      const startedAt = Date.now();
      const outcome = await this.connectOnce();
      if (this.stopped) break;
      if (outcome) return outcome;
      // A link that held for a while earns a fresh backoff.
      if (Date.now() - startedAt > 60_000) delay = backoff.initialMs;
      this.options.onState("offline", `reconnecting in ${Math.round(delay / 1000)} s`);
      await Promise.race([sleep(delay), new Promise<void>((resolve) => { this.wake = resolve; })]);
      this.wake = null;
      delay = Math.min(backoff.maxMs, Math.round(delay * 2 * (0.75 + Math.random() * 0.5)));
    }
    return this.stopped ?? { reason: "stopped", detail: "stopped" };
  }

  stop(detail = "stopped"): void {
    if (!this.stopped) this.stopped = { reason: "stopped", detail };
    this.teardown();
    this.wake?.();
  }

  /** One connection's life. Resolves null to reconnect, or with the final reason. */
  private connectOnce(): Promise<LinkStop | null> {
    const { promise, resolve } = Promise.withResolvers<LinkStop | null>();
    let settled = false;
    const finish = (value: LinkStop | null) => {
      if (settled) return;
      settled = true;
      this.teardown();
      resolve(value);
    };
    let socket: WebSocket;
    try {
      const connect = this.options.connect ?? ((url, headers) => new WebSocket(url, { headers } as unknown as string[]));
      socket = connect(linkUrl(this.options.planeUrl), { authorization: `Bearer ${this.options.token}` });
    } catch (error) {
      this.options.onState("offline", error instanceof Error ? error.message : String(error));
      return Promise.resolve(null);
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    const mux = new Mux(
      "runner",
      {
        send: (message) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(message);
        },
      },
      {
        onRpc: this.options.rpc,
        onStreamOpen: this.options.stream,
        onWelcome: (frame) => {
          void this.welcomed(frame, mux).then((stop) => {
            if (stop) finish(stop);
          });
        },
      },
    );
    this.mux = mux;
    socket.onopen = () => {
      mux.send(helloFrame(this.options));
    };
    socket.onmessage = (event) => {
      mux.receive(event.data as string | ArrayBuffer);
    };
    socket.onerror = () => {
      /* onclose follows with the code */
    };
    socket.onclose = (event) => {
      mux.close(`link closed (${event.code})`);
      if (event.code === CLOSE_TOKEN_REJECTED) {
        finish({ reason: "token_rejected", detail: event.reason || "the control plane rejected the runner token" });
      } else if (event.code === CLOSE_RUNNER_TOO_OLD) {
        finish({ reason: "runner_too_old", detail: event.reason || "the control plane needs a newer runner" });
      } else {
        this.options.onState("offline", event.reason || `closed (${event.code})`);
        finish(null);
      }
    };
    return promise;
  }

  private async welcomed(frame: WelcomeFrame, mux: Mux): Promise<LinkStop | null> {
    if (frame.protocol < MIN_PLANE_PROTOCOL) {
      return { reason: "plane_too_old", detail: `the control plane speaks protocol ${frame.protocol}; this runner needs ${MIN_PLANE_PROTOCOL}` };
    }
    if (PROTOCOL_VERSION < frame.minProtocol) {
      return { reason: "runner_too_old", detail: `the control plane needs protocol ${frame.minProtocol}; this runner speaks ${PROTOCOL_VERSION}` };
    }
    this.image = frame.image;
    try {
      await this.options.onWelcome(frame);
    } catch (error) {
      // The image could not be made ready; drop this link so the next attempt pulls again.
      this.options.onState("offline", error instanceof Error ? error.message : String(error));
      if (this.mux === mux) this.socket?.close(1000, "image not ready");
      return null;
    }
    if (this.mux !== mux) return null;
    this.options.onState("online", this.options.planeUrl);
    const beat = () => {
      mux.send({
        t: "heartbeat",
        capacity: this.options.capacity(),
        logins: this.options.logins(),
        imageDigest: this.options.imageDigest(),
      });
    };
    beat();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(beat, Math.max(1, frame.heartbeatSeconds) * 1000);
    return null;
  }

  private teardown(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.mux?.close("link torn down");
    this.mux = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
  }
}
