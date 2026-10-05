/** Which app routes' code gets warmed after the first page, and how a build's
 *  per-route client reference manifests name that code. Pure; the route handler
 *  reads the files and the client fetches the result. */

/** Not reachable from the signed-in shell, so never warmed. */
const SKIPPED_ROUTES = ["/lab", "/login", "/signup", "/desktop-auth", "/download", "/foundation", "/_not-found", "/_global-error"];

/** The app route a page manifest belongs to, from its path under `server/app`:
 *  `(workspace)/dashboard/page_client-reference-manifest.js` is `/dashboard`.
 *  Route groups vanish; dynamic segments stay as written. */
export function routeOfManifestPath(relativePath: string): string {
  const dir = relativePath.replace(/\/?page_client-reference-manifest\.js$/, "");
  const segments = dir.split("/").filter((segment) => segment && !/^\(.*\)$/.test(segment));
  return `/${segments.join("/")}`;
}

export function isWarmedRoute(route: string): boolean {
  return !SKIPPED_ROUTES.some((skipped) => route === skipped || route.startsWith(`${skipped}/`));
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
