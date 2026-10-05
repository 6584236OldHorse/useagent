import { expect, test } from "bun:test";
import { createSessionRequest } from "./auth";

function countingFetcher(responses: (() => Response)[] = []) {
  const seen: string[] = [];
  const fetcher = (async (path: string) => {
    seen.push(path);
    const next = responses.shift();
    return next
      ? next()
      : Response.json({ user: { id: "u1", name: "Ada", email: "ada@example.com", image: null } });
  }) as unknown as Parameters<typeof createSessionRequest>[0];
  return { seen, fetcher };
}

test("every session consumer on a page shares one get-session request", async () => {
  const { seen, fetcher } = countingFetcher();
  const request = createSessionRequest(fetcher, { isShared: () => true });
  const [a, b] = await Promise.all([request.get(), request.get()]);
  expect(a?.user.email).toBe("ada@example.com");
  expect(b).toBe(a);
  expect(await request.get()).toBe(a);
  expect(seen).toEqual(["/api/auth/get-session"]);
});

test("invalidating the session asks the backend again", async () => {
  const { seen, fetcher } = countingFetcher();
  const request = createSessionRequest(fetcher, { isShared: () => true });
  await request.get();
  request.invalidate();
  await request.get();
  expect(seen).toHaveLength(2);
});

test("an anonymous answer is kept, a failed request is not", async () => {
  const { seen, fetcher } = countingFetcher([
    () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 401 }),
  ]);
  const request = createSessionRequest(fetcher, { isShared: () => true });
  await expect(request.get()).rejects.toThrow("503");
  expect(await request.get()).toBeNull();
  expect(await request.get()).toBeNull();
  expect(seen).toHaveLength(2);
});

test("the session answer expires after its ttl", async () => {
  const { seen, fetcher } = countingFetcher();
  const request = createSessionRequest(fetcher, { isShared: () => true, ttlMs: 0 });
  await request.get();
  await request.get();
  expect(seen).toHaveLength(2);
});
