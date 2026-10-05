/** Which app routes the shell prefetches and whose code gets warmed after the first
 *  page, and how a build's per-route client reference manifests name that code. Pure;
 *  the route handler reads the files and the client fetches the result. */

/** Every top-level page a signed-in user can reach from the rails, except /bots: its
 *  layout seeds the roster on the server above the loading boundary, so a router
 *  prefetch would cache that roster for the static window and the panel does not
 *  refresh its seed on first mount. Bots loads fresh on the hop. */
export const APP_ROUTES = [
  "/dashboard",
  "/agent/new",
  "/agent/runs",
  "/settings",
  "/skills",
  "/playbooks",
  "/agent/automations",
  "/knowledge",
  "/memory",
  "/learnings",
  "/wiki",
  "/review",
  "/apps",
  "/agent/artifacts",
  "/agent/plugins",
  "/tasks",
  "/secrets",
] as const;

/** The routes whose JavaScript is warmed at idle: what the rails link to (the prefetched
 *  routes, the thread rows and the bots rows). A detail page reached from inside a page
 *  (/wiki/[id], /agent/artifacts/[id]) and a page no rail links to (/session/new, /) load
 *  their own chunks on the hop. Measured on 2026-09-14: warming every route downloaded
 *  56 chunks, 603K on the wire, of which seven common hops used 26 (348K). */
const WARMED_ROUTES: ReadonlySet<string> = new Set([...APP_ROUTES, "/session/[id]", "/bots", "/bots/[id]"]);

/** The app route a page manifest belongs to, from its path under `server/app`:
 *  `(workspace)/dashboard/page_client-reference-manifest.js` is `/dashboard`.
 *  Route groups vanish; dynamic segments stay as written. */
export function routeOfManifestPath(relativePath: string): string {
  const dir = relativePath.replace(/\/?page_client-reference-manifest\.js$/, "");
  const segments = dir.split("/").filter((segment) => segment && !/^\(.*\)$/.test(segment));
  return `/${segments.join("/")}`;
}

export function isWarmedRoute(route: string): boolean {
  return WARMED_ROUTES.has(route);
}

/** The chunk URLs a client reference manifest names, each once. */
export function chunkUrlsIn(manifestText: string): string[] {
  const urls = new Set<string>();
  for (const match of manifestText.matchAll(/static\/chunks\/[A-Za-z0-9_.-]+\.js/g)) urls.add(`/_next/${match[0]}`);
  return [...urls];
}

/** Every chunk any warmed route's page needs, sorted, each once. */
export function collectRouteChunks(manifests: ReadonlyArray<{ path: string; text: string }>): string[] {
  const chunks = new Set<string>();
  for (const manifest of manifests) {
    if (!isWarmedRoute(routeOfManifestPath(manifest.path))) continue;
    for (const url of chunkUrlsIn(manifest.text)) chunks.add(url);
  }
  return [...chunks].sort();
}
