import { expect, test } from "bun:test";
import { createSessionRequest } from "./auth";

function countingFetcher() {
  const seen: string[] = [];
  const fetcher = (async (path: string) => {
    seen.push(path);
    return Response.json({ user: { id: "u1", name: "Ada", email: "ada@example.com", image: null } });
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
