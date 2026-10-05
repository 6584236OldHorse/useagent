import { expect, test } from "bun:test";
import { cachedRequest } from "./cached-request";

const shared = { isShared: () => true };

test("concurrent and later callers share one request", async () => {
  let calls = 0;
  const request = cachedRequest(async () => ++calls, shared);
  expect(await Promise.all([request.get(), request.get()])).toEqual([1, 1]);
  expect(await request.get()).toBe(1);
  expect(request.peek()).toBe(1);
  expect(calls).toBe(1);
});

test("fresh replaces a settled value but joins a pending request", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const request = cachedRequest(
    () => new Promise<number>((resolve) => {
      calls += 1;
      release = () => resolve(calls);
    }),
    shared,
  );
  const first = request.get();
  const joined = request.get(true);
  release?.();
  expect(await Promise.all([first, joined])).toEqual([1, 1]);
  const second = request.get(true);
  release?.();
  expect(await second).toBe(2);
  expect(calls).toBe(2);
});

test("invalidate forgets the value and detaches a pending request", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const request = cachedRequest(
    () => new Promise<number>((resolve) => {
      calls += 1;
      release = () => resolve(calls);
    }),
    shared,
  );
  const stale = request.get();
  request.invalidate();
  release?.();
  expect(await stale).toBe(1);
  expect(request.peek()).toBeUndefined();
  const next = request.get();
  release?.();
  expect(await next).toBe(2);
});

test("a failed request is not kept", async () => {
  let calls = 0;
  const request = cachedRequest(async () => {
    calls += 1;
    if (calls === 1) throw new Error("offline");
    return calls;
  }, shared);
  await expect(request.get()).rejects.toThrow("offline");
  expect(await request.get()).toBe(2);
});

test("the value expires after the ttl, counted from when it settled", async () => {
  let calls = 0;
  const request = cachedRequest(async () => ++calls, { ...shared, ttlMs: 0 });
  await request.get();
  expect(request.peek()).toBeUndefined();
  expect(await request.get()).toBe(2);
});

test("outside the browser every caller loads for itself", async () => {
  let calls = 0;
  const request = cachedRequest(async () => ++calls, { isShared: () => false });
  expect(await Promise.all([request.get(), request.get()])).toEqual([1, 2]);
  expect(request.peek()).toBeUndefined();
});
