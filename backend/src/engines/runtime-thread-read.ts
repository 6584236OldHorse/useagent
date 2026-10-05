// One read of a runtime thread over HTTP: its bounded snapshot, decoded, and
// the plane's view of it. Every path that reads a thread outside a live turn
// (session start, reconcile, a reply to an approval or a question, a cancel)
// reads it here.
import type { SandboxHandle } from "../sandboxes/provider";
import { requestRuntimeEnvironment, runtimeThreadSnapshotRequest } from "./runtime-environment-client";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";
import { runtimeThreadView } from "./runtime-v2-view";
import { decodeV2ThreadSnapshot, type V2ThreadSnapshot } from "./runtime-v2-wire";

export function decodeRuntimeThreadResponse(value: unknown): V2ThreadSnapshot {
  const snapshot = decodeV2ThreadSnapshot(value);
  if (!snapshot) throw new Error("The provider runtime returned a malformed thread snapshot");
  return snapshot;
}

export async function readRuntimeThread(
  sandbox: SandboxHandle,
  threadId: string,
  signal: AbortSignal,
  request: typeof requestRuntimeEnvironment = requestRuntimeEnvironment,
): Promise<V2ThreadSnapshot> {
  return decodeRuntimeThreadResponse(
    await request<unknown>(sandbox, runtimeThreadSnapshotRequest(threadId), signal),
  );
}

export async function readRuntimeThreadView(
  sandbox: SandboxHandle,
  threadId: string,
  signal: AbortSignal,
  request: typeof requestRuntimeEnvironment = requestRuntimeEnvironment,
): Promise<RuntimeThreadSnapshot> {
  return runtimeThreadView(await readRuntimeThread(sandbox, threadId, signal, request));
}
