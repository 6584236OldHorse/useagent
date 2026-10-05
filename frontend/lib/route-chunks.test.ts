import { expect, test } from "bun:test";
import { chunkUrlsIn, collectRouteChunks, isWarmedRoute, routeOfManifestPath } from "./route-chunks";

const manifest = (chunks: string[]) =>
  `globalThis.__RSC_MANIFEST["/x/page"] = {"clientModules":{"[project]/frontend/components/a.tsx":{"id":1,"name":"*","chunks":[${chunks.map((c) => `"${c}"`).join(",")}],"async":false}}};`;

test("a manifest path names its app route without route groups", () => {
  expect(routeOfManifestPath("(workspace)/dashboard/page_client-reference-manifest.js")).toBe("/dashboard");
  expect(routeOfManifestPath("session/(thread)/[id]/page_client-reference-manifest.js")).toBe("/session/[id]");
  expect(routeOfManifestPath("page_client-reference-manifest.js")).toBe("/");
  expect(routeOfManifestPath("(library)/agent/artifacts/[id]/page_client-reference-manifest.js")).toBe("/agent/artifacts/[id]");
});

test("only routes reachable from the signed-in shell are warmed", () => {
  for (const route of ["/", "/dashboard", "/session/[id]", "/bots/[id]", "/agent/new"]) expect(isWarmedRoute(route)).toBe(true);
  for (const route of ["/lab", "/lab/session", "/login/[[...login]]", "/signup", "/desktop-auth", "/download", "/foundation", "/_not-found", "/_global-error"]) {
    expect(isWarmedRoute(route)).toBe(false);
  }
});

test("chunk urls are read once each and rooted under _next", () => {
  const text = manifest(["static/chunks/a1.js", "static/chunks/a1.js", "static/chunks/b-2_c.js", "static/chunks/styles.css"]);
  expect(chunkUrlsIn(text)).toEqual(["/_next/static/chunks/a1.js", "/_next/static/chunks/b-2_c.js"]);
});

test("the union over warmed routes is sorted and skips excluded routes", () => {
  const chunks = collectRouteChunks([
    { path: "(workspace)/dashboard/page_client-reference-manifest.js", text: manifest(["static/chunks/z.js", "static/chunks/shared.js"]) },
    { path: "(library)/skills/page_client-reference-manifest.js", text: manifest(["static/chunks/shared.js", "static/chunks/skills.js"]) },
    { path: "lab/session/page_client-reference-manifest.js", text: manifest(["static/chunks/lab-only.js"]) },
  ]);
  expect(chunks).toEqual(["/_next/static/chunks/shared.js", "/_next/static/chunks/skills.js", "/_next/static/chunks/z.js"]);
});
