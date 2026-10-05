import { expect, test } from "bun:test";
import { chunksToWarm, shouldWarm, warmRouteChunks } from "./warm-route-chunks";

const memoryStorage = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
};

const fakeFetch = (chunks: string[], buildId = "b1") => {
  const calls: Array<{ url: string; priority?: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, priority: (init as { priority?: string } | undefined)?.priority });
    if (url === "/route-chunks") return Response.json({ buildId, chunks });
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

test("chunks already on the page are not requested again", () => {
  const chunks = ["/_next/static/chunks/a.js", "/_next/static/chunks/b.js", "/_next/static/chunks/c.js"];
  expect(chunksToWarm(chunks, ["https://app.example/_next/static/chunks/b.js", "not a url"])).toEqual([
    "/_next/static/chunks/a.js",
    "/_next/static/chunks/c.js",
  ]);
});

test("slow or metered connections are left alone", () => {
  expect(shouldWarm(undefined)).toBe(true);
  expect(shouldWarm({ effectiveType: "4g" })).toBe(true);
  expect(shouldWarm({ saveData: true, effectiveType: "4g" })).toBe(false);
  expect(shouldWarm({ effectiveType: "3g" })).toBe(false);
  expect(shouldWarm({ effectiveType: "slow-2g" })).toBe(false);
});

test("warming fetches each missing chunk at low priority, once per build", async () => {
  const chunks = ["/_next/static/chunks/a.js", "/_next/static/chunks/b.js", "/_next/static/chunks/c.js"];
  const { fetchImpl, calls } = fakeFetch(chunks);
  const storage = memoryStorage();
  const loaded = () => ["http://localhost/_next/static/chunks/b.js"];
  expect(await warmRouteChunks({ fetchImpl, storage, loaded, concurrency: 2 })).toBe(2);
  expect(calls.map((c) => c.url)).toEqual(["/route-chunks", "/_next/static/chunks/a.js", "/_next/static/chunks/c.js"]);
  expect(calls.slice(1).every((c) => c.priority === "low")).toBe(true);
  expect(await warmRouteChunks({ fetchImpl, storage, loaded })).toBe(0);
  expect(calls.filter((c) => c.url === "/route-chunks")).toHaveLength(2);
  expect(calls).toHaveLength(4);
});

test("a metered connection skips even the list", async () => {
  const { fetchImpl, calls } = fakeFetch(["/_next/static/chunks/a.js"]);
  expect(await warmRouteChunks({ fetchImpl, storage: memoryStorage(), loaded: () => [], connection: { saveData: true } })).toBe(0);
  expect(calls).toHaveLength(0);
});
