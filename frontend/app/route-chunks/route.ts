import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveDistDir } from "@/lib/build-dist";
import { collectRouteChunks } from "@/lib/route-chunks";

export const dynamic = "force-dynamic";

const MANIFEST = "page_client-reference-manifest.js";

/** The build's chunk list never changes for the life of the process. */
let cached: Promise<{ buildId: string; chunks: string[] }> | null = null;

async function loadRouteChunks(): Promise<{ buildId: string; chunks: string[] }> {
  const dist = path.join(process.cwd(), resolveDistDir(process.env.NODE_ENV === "production"));
  const appDir = path.join(dist, "server", "app");
  const manifests: Array<{ path: string; text: string }> = [];
  for (const entry of await readdir(appDir, { recursive: true })) {
    const relative = String(entry);
    if (!relative.endsWith(MANIFEST)) continue;
    manifests.push({ path: relative, text: await readFile(path.join(appDir, relative), "utf8") });
  }
  const buildId = (await readFile(path.join(dist, "BUILD_ID"), "utf8")).trim();
  return { buildId, chunks: collectRouteChunks(manifests) };
}

/** The JavaScript every signed-in route needs, so the shell can warm it at idle.
 *  Chunks are content-hashed and immutable; the list is keyed by the build. */
export async function GET(request: Request): Promise<Response> {
  cached ??= loadRouteChunks().catch((error: unknown) => {
    cached = null;
    throw error;
  });
  let result: { buildId: string; chunks: string[] };
  try {
    result = await cached;
  } catch (error: unknown) {
    // The dev server has no complete manifest set; nothing to warm there. In
    // production this means the build directory moved: say so once per process.
    if (process.env.NODE_ENV === "production") console.warn("route-chunks: no build manifests found", error);
    return Response.json({ buildId: "development", chunks: [] }, { headers: { "cache-control": "no-store" } });
  }
  const etag = `"${result.buildId}"`;
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
  return Response.json(result, { headers: { etag, "cache-control": "private, max-age=3600" } });
}
