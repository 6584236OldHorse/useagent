// Wire frames of the runner link. One WebSocket carries two kinds of message:
//   text frames   - JSON control frames (everything below except stream data)
//   binary frames - stream payload: [0x01][u32 stream id, big endian][bytes]
// The mux (./mux.ts) is the only reader and writer of these; the runner and
// the control plane see RPC calls and byte streams, never frames.

export interface RunnerCapacity {
  /** Logical CPUs the runner will lend to sandboxes. */
  readonly cpu: number;
  /** Memory in MiB the runner will lend to sandboxes. */
  readonly memoryMb: number;
  /** Sandboxes currently resident on the runner. */
  readonly sandboxes: number;
  /** Upper bound the runner enforces, when it has one. */
  readonly maxSandboxes?: number;
}

export interface ImageRef {
  /** OCI reference the runner pulls, e.g. ghcr.io/useagenthq/sandbox:2026-09-08. */
  readonly ref: string;
  /** Manifest digest the runner verifies after the pull; "sha256:...". */
  readonly digest: string;
}

export type RunnerBackendKind = "docker" | "apple";
const BACKEND_KINDS: ReadonlySet<string> = new Set<RunnerBackendKind>(["docker", "apple"]);

/** First frame from the runner after the socket opens. */
export interface HelloFrame {
  readonly t: "hello";
  readonly runnerId: string;
  /** Runner binary version (release tag). */
  readonly version: string;
  readonly protocol: number;
  readonly backend: RunnerBackendKind;
  readonly platform: string;
  readonly capacity: RunnerCapacity;
  /** Engine CLIs whose login the runner can lend to a sandbox, e.g. ["codex"]. */
  readonly logins: readonly string[];
  readonly imageDigest: string | null;
}

/** The control plane's answer to hello. Anything else before it is a protocol error. */
export interface WelcomeFrame {
  readonly t: "welcome";
  readonly protocol: number;
  readonly minProtocol: number;
  readonly image: ImageRef;
  readonly heartbeatSeconds: number;
  /** The control plane's release fingerprint, for the runner's compatibility check. */
  readonly release: string;
}

export interface HeartbeatFrame {
  readonly t: "heartbeat";
  readonly capacity: RunnerCapacity;
  readonly logins: readonly string[];
  readonly imageDigest: string | null;
  /** 1-minute load average when the runner can read it. */
  readonly load?: number;
}

export interface RpcFrame {
  readonly t: "rpc";
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}

export interface RpcResultFrame {
  readonly t: "rpc.result";
  readonly id: number;
  readonly result: unknown;
}

export interface RpcErrorFrame {
  readonly t: "rpc.error";
  readonly id: number;
  readonly code: string;
  readonly message: string;
}

export interface StreamOpenFrame {
  readonly t: "stream.open";
  readonly id: number;
  readonly target: unknown;
  /** Bytes the opener will accept in flight from the acceptor. */
  readonly window?: number;
}

export interface StreamOpenedFrame {
  readonly t: "stream.opened";
  readonly id: number;
  /** Bytes the acceptor will accept in flight from the opener. */
  readonly window?: number;
}

export interface StreamRefusedFrame {
  readonly t: "stream.refused";
  readonly id: number;
  readonly code: string;
  readonly message: string;
}

/** The receiver consumed `bytes` and the sender may send that much more. */
export interface StreamCreditFrame {
  readonly t: "stream.credit";
  readonly id: number;
  readonly bytes: number;
}

/** Half-close: the sender has no more data. The other direction stays open. */
export interface StreamCloseFrame {
  readonly t: "stream.close";
  readonly id: number;
}

/** Abort both directions at once. */
export interface StreamResetFrame {
  readonly t: "stream.reset";
  readonly id: number;
  readonly reason: string;
}

/** Something happened on the runner that belongs on the record. */
export interface EventFrame {
  readonly t: "event";
  readonly sandboxId: string | null;
  readonly kind: string;
  readonly detail: unknown;
}

export type ControlFrame =
  | HelloFrame
  | WelcomeFrame
  | HeartbeatFrame
  | RpcFrame
  | RpcResultFrame
  | RpcErrorFrame
  | StreamOpenFrame
  | StreamOpenedFrame
  | StreamRefusedFrame
  | StreamCreditFrame
  | StreamCloseFrame
  | StreamResetFrame
  | EventFrame;

const DATA_FRAME_TAG = 0x01;
const DATA_HEADER_BYTES = 5;

export function encodeDataFrame(streamId: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(DATA_HEADER_BYTES + payload.byteLength);
  frame[0] = DATA_FRAME_TAG;
  new DataView(frame.buffer).setUint32(1, streamId >>> 0);
  frame.set(payload, DATA_HEADER_BYTES);
  return frame;
}

export function decodeDataFrame(frame: Uint8Array): { streamId: number; payload: Uint8Array } | null {
  if (frame.byteLength < DATA_HEADER_BYTES || frame[0] !== DATA_FRAME_TAG) return null;
  const streamId = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1);
  return { streamId, payload: frame.subarray(DATA_HEADER_BYTES) };
}

const FRAME_TYPES = new Set<ControlFrame["t"]>([
  "hello",
  "welcome",
  "heartbeat",
  "rpc",
  "rpc.result",
  "rpc.error",
  "stream.open",
  "stream.opened",
  "stream.refused",
  "stream.credit",
  "stream.close",
  "stream.reset",
  "event",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStreamId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

/** A window, when present, is a positive safe integer; anything else makes the frame malformed. */
function isOptionalWindow(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);
}

function isCapacity(value: unknown): value is RunnerCapacity {
  return (
    isRecord(value) &&
    typeof value.cpu === "number" &&
    typeof value.memoryMb === "number" &&
    typeof value.sandboxes === "number" &&
    (value.maxSandboxes === undefined || typeof value.maxSandboxes === "number")
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isImageRef(value: unknown): value is ImageRef {
  return isRecord(value) && typeof value.ref === "string" && typeof value.digest === "string";
}

/**
 * Parse one text frame. Returns null for anything that is not a well-formed
 * frame of a known type, so a peer can ignore what it does not understand
 * (the additive rule in ./version.ts). Field shapes beyond the id and type
 * are the handlers' concern.
 */
export function parseControlFrame(text: string): ControlFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.t !== "string" || !FRAME_TYPES.has(value.t as ControlFrame["t"])) {
    return null;
  }
  switch (value.t) {
    case "rpc":
      return isStreamId(value.id) && typeof value.method === "string" ? (value as unknown as RpcFrame) : null;
    case "rpc.result":
    case "stream.close":
      return isStreamId(value.id) ? (value as unknown as ControlFrame) : null;
    case "stream.open":
    case "stream.opened":
      return isStreamId(value.id) && isOptionalWindow(value.window) ? (value as unknown as ControlFrame) : null;
    case "rpc.error":
    case "stream.refused":
      return isStreamId(value.id) && typeof value.code === "string" && typeof value.message === "string"
        ? (value as unknown as ControlFrame)
        : null;
    case "stream.credit":
      return isStreamId(value.id) && Number.isSafeInteger(value.bytes) && (value.bytes as number) > 0
        ? (value as unknown as StreamCreditFrame)
        : null;
    case "stream.reset":
      return isStreamId(value.id) && typeof value.reason === "string" ? (value as unknown as StreamResetFrame) : null;
    case "hello":
      return typeof value.runnerId === "string" &&
        typeof value.version === "string" &&
        typeof value.protocol === "number" &&
        typeof value.backend === "string" &&
        BACKEND_KINDS.has(value.backend) &&
        typeof value.platform === "string" &&
        isCapacity(value.capacity) &&
        isStringArray(value.logins) &&
        (value.imageDigest === null || typeof value.imageDigest === "string")
        ? (value as unknown as HelloFrame)
        : null;
    case "welcome":
      return typeof value.protocol === "number" &&
        typeof value.minProtocol === "number" &&
        isImageRef(value.image) &&
        typeof value.heartbeatSeconds === "number" &&
        typeof value.release === "string"
        ? (value as unknown as WelcomeFrame)
        : null;
    case "heartbeat":
      return isCapacity(value.capacity) &&
        isStringArray(value.logins) &&
        (value.imageDigest === null || typeof value.imageDigest === "string") &&
        (value.load === undefined || typeof value.load === "number")
        ? (value as unknown as HeartbeatFrame)
        : null;
    case "event":
      return typeof value.kind === "string" && (value.sandboxId === null || typeof value.sandboxId === "string")
        ? (value as unknown as EventFrame)
        : null;
    default:
      return null;
  }
}

export function encodeControlFrame(frame: ControlFrame): string {
  return JSON.stringify(frame);
}
