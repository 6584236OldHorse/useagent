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

test("fresh and invalidate replace the cached value", async () => {
  let calls = 0;
  const request = cachedRequest(async () => ++calls, shared);
  await request.get();
  expect(await request.get(true)).toBe(2);
  request.invalidate();
  expect(request.peek()).toBeUndefined();
  expect(await request.get()).toBe(3);
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

test("the value expires after the ttl", async () => {
  let calls = 0;
  const request = cachedRequest(async () => ++calls, { ...shared, ttlMs: 0 });
  await request.get();
  expect(await request.get()).toBe(2);
});

test("outside the browser every caller loads for itself", async () => {
  let calls = 0;
  const request = cachedRequest(async () => ++calls, { isShared: () => false });
  expect(await Promise.all([request.get(), request.get()])).toEqual([1, 2]);
  expect(request.peek()).toBeUndefined();
});
