import { describe, expect, test } from "bun:test";
import type { backendFetch } from "./backend-fetch";
import { createRepoListRequest } from "./repo-list";

const shared = { isShared: () => true };
const listing = { repos: [{ full_name: "acme/api", name: "api", private: true, default_branch: "main" }, { name: "no-full-name" }] };

function fetcher(responses: Array<{ status: number; body?: unknown }>): { fetch: typeof backendFetch; calls: number } {
  const state = { calls: 0, fetch: (async () => {
    const next = responses[Math.min(state.calls, responses.length - 1)] ?? { status: 500 };
    state.calls += 1;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  }) as typeof backendFetch };
  return state;
}

describe("the repository list is one request per page", () => {
  test("concurrent consumers share one request and later consumers reuse its answer", async () => {
    const f = fetcher([{ status: 200, body: listing }]);
    const request = createRepoListRequest(f.fetch, shared);
    const [a, b] = await Promise.all([request.get(), request.get()]);
    expect(f.calls).toBe(1);
    expect(a).toEqual([{ full_name: "acme/api", name: "api", private: true, default_branch: "main" }]);
    expect(b).toBe(a);
    expect(await request.get()).toBe(a);
    expect(f.calls).toBe(1);
  });

  test("a failed request is not kept: the next consumer asks again", async () => {
    const f = fetcher([{ status: 503 }, { status: 200, body: listing }]);
    const request = createRepoListRequest(f.fetch, shared);
    await expect(request.get()).rejects.toThrow("repos failed: 503");
    expect((await request.get()).length).toBe(1);
    expect(f.calls).toBe(2);
  });

  test("an unconfigured deployment answers an empty list that is kept", async () => {
    const f = fetcher([{ status: 200, body: {} }]);
    const request = createRepoListRequest(f.fetch, shared);
    expect(await request.get()).toEqual([]);
    expect(await request.get()).toEqual([]);
    expect(f.calls).toBe(1);
  });
});
