"use client";

import {
  createThreadConnection,
  decodeApiRun,
  decodeApiStep,
  type DecodedFrame,
  decodeFrame,
  type EventSourceLike,
  NATIVE_CURSOR_LIMIT,
  nativeHoldDigest,
  THREAD_FRAME_TYPES,
  type ThreadConnection,
  RUN_STATUSES,
} from "@useagent/agent-client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import type { StoredCanonicalEvent } from "./canonical-timeline";
import { EXECUTION_SUMMARY_ROLLOUT_MODE } from "./execution-summary-rollout";
import { parseNativeFrame } from "./native-events";
import { createThreadStore, type ThreadSnapshot, type ThreadStore } from "./thread-store";
import { type ApiRun, toThread } from "./types";

const RUN_STATUS_SET: ReadonlySet<string> = new Set(RUN_STATUSES);

// useThreadStream — the session page's realtime unit (final_fix.md §4.7). ONE
// EventSource to the thread endpoint for the page lifetime, keyed by the ROOT thread
// id (NOT the active/newest/running run). Creating/queueing/starting/settling/
// cancelling a run never resets the store or reconnects. The reconnect / health /
// fallback-poll state machine lives in a pure, injectable controller
// (thread-connection.ts) so it is deterministically testable.

export interface ReconcileResult {
  readonly ok: boolean;
  readonly runs?: ApiRun[];
}

export interface ThreadStreamState {
  snapshot: ThreadSnapshot;
  /** One-shot safety-net reconcile: fetch the durable thread once and MERGE it.
   *  Returns a typed result (never swallowed to void) so callers can react to a
   *  failed fetch instead of assuming success. */
  reconcile: () => Promise<ReconcileResult>;
  /** Merge already-decoded runs into the thread store (a windowed island fetch)
   *  - the same applySnapshot merge the reconcile path uses, without refetching
   *  the whole thread. */
  mergeRuns: (runs: readonly ApiRun[]) => void;
}

/** A new, unretained store for this root. */
export function freshThreadStore(rootRunId: string): ThreadStore {
  return createThreadStore({
    rootThreadId: rootRunId,
    executionSummaryEnabled: EXECUTION_SUMMARY_ROLLOUT_MODE !== "off",
  });
}

function seed(store: ThreadStore, rootRunId: string, initialThread: readonly ApiRun[]): ThreadStore {
  // Seed from `initialThread` ONLY when it actually belongs to this root, so a stale
  // SSR payload from a previously viewed thread never bleeds into a new one (Codex
  // finding 2).
  if (initialThread.length && initialThread[0]?.id === rootRunId) store.applySnapshot([...initialThread]);
  return store;
}

/** A fresh store seeded for this root: the server-render path (a request never
 *  keeps state for the next one) and the store a `reset` replaces with. */
export function seedThreadStore(rootRunId: string, initialThread: readonly ApiRun[]): ThreadStore {
  return seed(freshThreadStore(rootRunId), rootRunId, initialThread);
}

/** Stores the browser keeps after leaving a thread, keyed by root thread id and
 *  ordered oldest to most recently released. Coming back acquires the store the
 *  thread already had, so the reconnect asks the server only for what is newer than
 *  it holds. A store has ONE owner: acquiring takes it out of retention, releasing
 *  puts it back, so two mounted views of the same thread never share one store (each
 *  opens its own connection, and transient deltas are appended, not deduped).
 *  Bounded to the last few threads so memory stays flat. */
const RETAINED_STORES = 4;
const retained = new Map<string, ThreadStore>();

export function acquireThreadStore(rootRunId: string, initialThread: readonly ApiRun[]): ThreadStore {
  const kept = retained.get(rootRunId);
  retained.delete(rootRunId);
  return seed(kept ?? freshThreadStore(rootRunId), rootRunId, initialThread);
}

export function releaseThreadStore(rootRunId: string, store: ThreadStore): void {
  retained.delete(rootRunId);
  retained.set(rootRunId, store);
  while (retained.size > RETAINED_STORES) retained.delete(retained.keys().next().value as string);
}

/** Take this exact store back out of retention if a release put it there while the
 *  hook still owned it (an effect torn down and re-run for the same mount). */
export function claimThreadStore(rootRunId: string, store: ThreadStore): void {
  if (retained.get(rootRunId) === store) retained.delete(rootRunId);
}

/** Test seam: forget every retained store. */
export function resetRetainedThreadStoresForTest(): void {
  retained.clear();
}

/** What the store holds of one sealed run's native lane: the newest seq, and the digest
 *  of the (eventId, seq) pairs it holds (`nativeHoldDigest`, shared with the server). */
export interface NativeHold {
  readonly seq: number;
  readonly digest: string;
}

export interface ResumeCursor {
  readonly canonicalAfter: number;
  readonly canonicalId: string | null;
  /** Per run whose canonical lane the store saw complete, what it holds of the native lane. */
  readonly nativeAfter: ReadonlyMap<string, NativeHold>;
}

/** What the store already holds, as the server's resume cursors: the newest canonical
 *  delivery seq across the thread with the event id at that row, so the server can prove
 *  it still holds the same history, and per SEALED run the newest native seq with the
 *  digest of the frames held, which the server checks against the seal's watermark and
 *  its own rows below the cursor before it skips them. A live run's native frames always
 *  replay from zero (their seq is not a commit order). */
export function resumeCursor(snapshot: ThreadSnapshot): ResumeCursor {
  let canonicalAfter = 0;
  let canonicalId: string | null = null;
  const nativeAfter = new Map<string, NativeHold>();
  for (const [runId, view] of snapshot.byId) {
    for (const e of view.canonical) {
      if (e.deliverySeq > canonicalAfter) {
        canonicalAfter = e.deliverySeq;
        canonicalId = e.eventId;
      }
    }
    // Bounded to what the server reads; a sealed run past the bound replays from the start.
    if (view.canonicalComplete && view.native.nativeCursor >= 0 && nativeAfter.size < NATIVE_CURSOR_LIMIT) {
      nativeAfter.set(runId, { seq: view.native.nativeCursor, digest: nativeHoldDigest(view.native.nativeFrames) });
    }
  }
  return { canonicalAfter, canonicalId, nativeAfter };
}

/** The epoch of the backend process that delivered each store's canonical rows; a
 *  cursor is only sent back with it, so another process refuses it and replays. */
const streamEpochs = new WeakMap<ThreadStore, string>();

/** The stream URL, carrying the cursors only when the epoch that minted them is known. */
export function threadEventsUrl(rootRunId: string, cursor: ResumeCursor, epoch: string | null): string {
  const params = new URLSearchParams();
  const canonical = cursor.canonicalAfter > 0 && cursor.canonicalId !== null;
  if (epoch && (canonical || cursor.nativeAfter.size > 0)) {
    params.set("epoch", epoch);
    if (canonical) {
      params.set("canonicalAfter", String(cursor.canonicalAfter));
      params.set("canonicalId", cursor.canonicalId as string);
    }
    for (const [runId, hold] of cursor.nativeAfter) params.append("nativeAfter", `${runId}:${hold.seq}:${hold.digest}`);
  }
  const query = params.toString();
  return `/api/runs/${rootRunId}/thread-events${query ? `?${query}` : ""}`;
}

/** Retention is a browser matter: a server render must never keep one request's
 *  thread for the next. */
function mountThreadStore(rootRunId: string, initialThread: readonly ApiRun[]): ThreadStore {
  return typeof window === "undefined"
    ? seedThreadStore(rootRunId, initialThread)
    : acquireThreadStore(rootRunId, initialThread);
}

/** Whether an accepted optimistic reply can be retired: only once its durable run
 *  is present in the thread store, matched by run id (never prompt text — Codex
 *  finding 4). Pure + testable. */
export function shouldRetireOptimistic(
  runId: string | null | undefined,
  snapshot: ThreadSnapshot,
): boolean {
  return runId != null && snapshot.byId.has(runId);
}

/** Fetch the whole durable thread (oldest→newest), or null on any failure. */
async function fetchThread(rootRunId: string): Promise<ApiRun[] | null> {
  try {
    const res = await backendFetch(`/api/runs/${rootRunId}?thread=1`, { cache: "no-store" });
    if (!res.ok) return null;
    const runs = toThread(await res.json());
    return runs.length ? runs : null;
  } catch {
    return null;
  }
}

/** Apply ONE decoded thread frame to the addressed run's slice. The client library
 *  (`@useagent/agent-client`) owns the wire decode + canonical envelope validation
 *  (H4-equivalent: schemaVersion/kind/ids/seq/deliverySeq/revision/thread); this thin
 *  product adapter maps the typed frame onto the store's native + canonical lanes.
 *  Unknown/malformed frames are ignored (bounded), never applied or fatal. */
export function applyDecodedFrame(store: ThreadStore, frame: DecodedFrame): void {
  switch (frame.kind) {
    case "canonical":
      // The wire event is the same shape the store's canonical lane stores; the client
      // added deliverySeq/revision and validated the envelope. One cast at the
      // package<->product type boundary (runtime shape is identical + already validated).
      store.applyCanonical(frame.event as unknown as StoredCanonicalEvent);
      return;
    case "canonical-complete":
      // H2: mark a run's canonical projection trustworthy. Until this arrives the render
      // path stays on the legacy native lane even if provisional canonical rows exist.
      store.markCanonicalComplete(frame.complete.runId, frame.complete.degraded);
      return;
    case "raw": {
      const p = frame.payload;
      switch (frame.type) {
        case "snapshot": {
          const runs = toThread({ thread: (p as { runs?: unknown }).runs });
          if (runs.length) store.applySnapshot(runs);
          return;
        }
        case "run": {
          const run = decodeApiRun((p as { run?: unknown }).run);
          if (run) store.upsertRun(run);
          return;
        }
        case "step": {
          const runId = p.runId as string | undefined;
          const step = decodeApiStep((p as { step?: unknown }).step);
          if (runId && step) store.applyStep(runId, step);
          return;
        }
        case "delta": {
          const runId = p.runId as string | undefined;
          const delta = p.delta;
          // `kind: "reasoning"` tags a live thinking delta (subdued Thinking
          // affordance); any other/absent value is answer narration.
          const kind = p.kind === "reasoning" ? "reasoning" : undefined;
          if (runId && typeof delta === "string") store.applyDelta(runId, delta, kind);
          return;
        }
        case "native": {
          const runId = p.runId as string | undefined;
          if (!runId) return;
          const nf = parseNativeFrame((p as { frame?: unknown }).frame);
          if (nf) store.applyNative(runId, nf);
          return;
        }
        case "done": {
          const runId = p.runId as string | undefined;
          const status = typeof p.status === "string" && RUN_STATUS_SET.has(p.status)
            ? p.status as (typeof RUN_STATUSES)[number]
            : null;
          if (runId && status) store.applyDone(runId, status);
          return;
        }
      }
      return;
    }
    case "resume":
      // A reset is handled by the flush that owns the store swap. The epoch travels
      // with the store so a later reconnect sends the cursor back to the process that
      // minted it, and a fresh process refuses it and replays.
      if (frame.resume.epoch) streamEpochs.set(store, frame.resume.epoch);
      return;
    case "unknown":
    case "malformed":
      return;
  }
}

/** Browser EventSource adapted to the controller's minimal EventSourceLike. */
function browserEventSource(url: string): EventSourceLike {
  const es = new EventSource(url);
  const adapter: EventSourceLike = {
    addEventListener: (type, fn) =>
      es.addEventListener(type, (e) => fn({ data: (e as MessageEvent).data })),
    close: () => es.close(),
    onopen: null,
    onerror: null,
  };
  es.onopen = () => adapter.onopen?.();
  es.onerror = () => adapter.onerror?.();
  return adapter;
}

export function useThreadStream(rootRunId: string, initialThread: ApiRun[]): ThreadStreamState {
  // Store lifetime is keyed by the ROOT thread id: recreate + reseed when rootRunId
  // changes, but NOT when a run is added to the same thread (adjust-state-on-prop-
  // change — cheaper + flicker-free vs. remount-by-key; Codex finding 2).
  const [store, setStore] = useState<ThreadStore>(() => mountThreadStore(rootRunId, initialThread));
  const [storeRoot, setStoreRoot] = useState(rootRunId);
  if (rootRunId !== storeRoot) {
    setStore(mountThreadStore(rootRunId, initialThread));
    setStoreRoot(rootRunId);
  }
  const storeRef = useRef(store);
  storeRef.current = store;

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const reconcile = useCallback(async (): Promise<ReconcileResult> => {
    // Bound to the store mounted when the fetch started: a response that lands after
    // a navigation or a reset never reaches the store that replaced it.
    const target = storeRef.current;
    const runs = await fetchThread(rootRunId);
    if (!runs || target !== storeRef.current) return { ok: false };
    target.applySnapshot(runs);
    return { ok: true, runs };
  }, [rootRunId]);

  const mergeRuns = useCallback((runs: readonly ApiRun[]) => {
    if (runs.length > 0) storeRef.current.applySnapshot(runs);
  }, []);

  useEffect(() => {
    // The store this effect owns: the one mounted for this root, replaced by a reset.
    // Every late result (a poll, a settlement fetch) lands here, never on whatever
    // store a later navigation mounted, and never after this effect is torn down.
    let active = storeRef.current;
    let cancelled = false;
    claimThreadStore(rootRunId, active);
    // Coalesce SSE frames: opening a long SETTLED run replays hundreds of native
    // frames back-to-back (this run: 463 frames / ~1MB). Applying each immediately
    // notifies the store per frame -> a full re-render + timeline rebuild of the
    // whole (growing) timeline each time = O(n^2) over ~1MB, which froze the tab for
    // minutes. Buffer frames and apply the burst in ONE store.batch() per animation
    // frame -> a single render for the burst (opencode-style "apply burst, paint once").
    let buffer: { event: string; data: string }[] = [];
    let scheduled: ReturnType<typeof setTimeout> | number | null = null;
    let conn: ThreadConnection | null = null;
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
    const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null;
    const applyBurst = (target: ThreadStore, frames: readonly DecodedFrame[]): void => {
      if (frames.length === 0) return;
      target.batch(() => {
        for (const frame of frames) {
          applyDecodedFrame(target, frame);
          if (frame.kind === "canonical-complete") {
            conn?.requestSettlementReconcile(frame.complete.runId);
          } else if (frame.kind === "raw" && frame.type === "done") {
            const runId = frame.payload.runId;
            if (typeof runId === "string") conn?.requestSettlementReconcile(runId);
          }
        }
      });
    };
    const flushFrames = (): void => {
      scheduled = null;
      if (buffer.length === 0) return;
      const burst = buffer;
      buffer = [];
      let target = active;
      let pending: DecodedFrame[] = [];
      for (const f of burst) {
        const frame = decodeFrame(f.event, f.data);
        if (frame.kind === "resume" && frame.resume.reset) {
          // The server refused what this store held (a rollback, another database):
          // finish the frames before the reset on the old store, then replace it and
          // apply the from-zero replay that follows to the fresh one.
          applyBurst(target, pending);
          pending = [];
          target = freshThreadStore(rootRunId);
          active = target;
          storeRef.current = target;
          setStore(target);
          continue;
        }
        pending.push(frame);
      }
      applyBurst(target, pending);
    };
    const onFrame = (event: string, data: string): void => {
      buffer.push({ event, data });
      if (scheduled != null) return;
      scheduled = raf ? raf(flushFrames) : setTimeout(flushFrames, 0);
    };
    const reconcileSettlement = async (runId: string): Promise<boolean> => {
      // Bound to the store in place when the fetch started: a reset that lands while
      // the fetch is in flight must not receive the history it just discarded.
      const target = active;
      const runs = await fetchThread(rootRunId);
      if (!runs || cancelled || target !== active) return false;
      target.applySnapshot(runs);
      const run = runs.find((candidate) => candidate.id === runId);
      return !!run && run.status !== "queued" && run.status !== "running";
    };
    conn = createThreadConnection({
      // Recomputed on every (re)connect: the store's cursors tell the server what
      // to skip, so a reconnect or a return to a retained thread replays only the
      // newer frames instead of the whole history.
      url: () => threadEventsUrl(rootRunId, resumeCursor(active.getSnapshot()), streamEpochs.get(active) ?? null),
      frameTypes: THREAD_FRAME_TYPES,
      healthFrame: "snapshot",
      createEventSource: browserEventSource,
      onFrame,
      poll: () => {
        const target = active;
        void fetchThread(rootRunId).then((runs) => {
          if (runs && !cancelled && target === active) target.applySnapshot(runs);
        });
      },
      reconcileSettlement,
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
      },
    });
    conn.start();
    return () => {
      if (scheduled != null) {
        if (raf && caf) caf(scheduled as number);
        else clearTimeout(scheduled as ReturnType<typeof setTimeout>);
      }
      conn.stop();
      cancelled = true;
      releaseThreadStore(rootRunId, active);
    };
    // Keyed by the ROOT thread id ONLY: a new run in the same thread never tears
    // down/reopens the connection; a genuine thread navigation does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootRunId]);

  return { snapshot, reconcile, mergeRuns };
}
