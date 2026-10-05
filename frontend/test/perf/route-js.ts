// First-load JavaScript per app route, from a production build: for each route, the
// chunks its client reference manifest names (the page, its layouts and the client
// components they reference) plus the root main files, sized raw and gzip. Chunks that
// only a next/dynamic boundary loads are not in the manifest, so they do not count.
// This is the figure the budget in AGENTS.md is written against.
//
//   bun run build && bun run perf:routes                 (every route, sorted by gzip)
//   bun test/perf/route-js.ts .next-build "/session/(thread)/[id]/page"
//
// The dist directory defaults to .next-build (what `bun run build` writes); pass the
// USEAGENT_BUILD_DIST value if the build used one.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { chunkUrlsIn, routeOfManifestPath } from "../../lib/route-chunks";

const [dist = ".next-build", ...only] = process.argv.slice(2);
const MANIFEST = "page_client-reference-manifest.js";
const rootMainFiles = (JSON.parse(readFileSync(join(dist, "build-manifest.json"), "utf8")) as { rootMainFiles: string[] })
  .rootMainFiles.map((file) => `/_next/${file}`);

const sizeOf = new Map<string, { raw: number; gzip: number }>();
function size(url: string): { raw: number; gzip: number } {
  const known = sizeOf.get(url);
  if (known) return known;
  const path = join(dist, url.replace(/^\/_next\//, ""));
  const bytes = existsSync(path) ? readFileSync(path) : null;
  const measured = bytes ? { raw: statSync(path).size, gzip: gzipSync(bytes).length } : { raw: 0, gzip: 0 };
  sizeOf.set(url, measured);
  return measured;
}

function manifests(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...manifests(full));
    else if (entry.name === MANIFEST) found.push(full);
  }
  return found;
}

const appDir = join(dist, "server", "app");
const rows = manifests(appDir)
  .map((file) => {
    const route = routeOfManifestPath(relative(appDir, file));
    const chunks = new Set([...rootMainFiles, ...chunkUrlsIn(readFileSync(file, "utf8"))]);
    let raw = 0;
    let gzip = 0;
    for (const chunk of chunks) {
      const s = size(chunk);
      raw += s.raw;
      gzip += s.gzip;
    }
    return { route, chunks: chunks.size, raw, gzip };
  })
  .filter((row) => only.length === 0 || only.some((wanted) => row.route === routeOfManifestPath(wanted) || row.route === wanted))
  .sort((a, b) => b.gzip - a.gzip);

const kb = (n: number) => `${Math.round(n / 1024)}K`;
console.log(`first-load JS per route (${dist}; raw / gzip; chunks incl. rootMainFiles)`);
for (const row of rows) console.log(`  ${row.route.padEnd(34)} ${String(row.chunks).padStart(3)} chunks  ${kb(row.raw).padStart(6)} / ${kb(row.gzip).padStart(5)}`);
