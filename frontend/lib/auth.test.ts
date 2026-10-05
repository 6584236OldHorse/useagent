import { expect, test } from "bun:test";
import { createSessionRequest, getAuthConfig, shouldReloadForOrganizationChange } from "./auth";

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

test("a provider identity rejected by the backend is not an authorized session", async () => {
  const { fetcher } = countingFetcher([() => new Response(null, { status: 403 })]);
  const request = createSessionRequest(fetcher, { isShared: () => true });
  await expect(request.get()).rejects.toThrow("get-session failed: 403");
});

test("legacy provider config keeps its shape on the dedicated route", async () => {
  const seen: string[] = [];
  const fetcher = (async (path: string) => {
    seen.push(path);
    return Response.json({ google: true, emailPassword: false, allowDevOrg: false });
  }) as unknown as Parameters<typeof getAuthConfig>[0];

  expect(await getAuthConfig(fetcher)).toEqual({
    google: true,
    emailPassword: false,
    allowDevOrg: false,
  });
  expect(seen).toEqual(["/api/auth/provider-config"]);
});

test("only a same-user organization change requires a document reload", () => {
  const first = { userId: "user-1", orgId: "org-1" };
  expect(shouldReloadForOrganizationChange(undefined, first)).toBe(false);
  expect(shouldReloadForOrganizationChange(first, first)).toBe(false);
  expect(shouldReloadForOrganizationChange(first, { ...first, orgId: "org-2" })).toBe(true);
  expect(shouldReloadForOrganizationChange(first, { userId: "user-2", orgId: "org-2" })).toBe(
    false,
  );
});
