// Gap 9 measurement: what the idle route prefetch + chunk warming downloads on a first
// page, and whether the common hops afterwards download any JS (a hit) or not.
// usage: bun perf-warm.ts <origin> <firstPath> <hop>[,<hop>...]
import { chromium } from "playwright-core";

const [origin = "http://localhost:3620", first = "/agent/new", hopsArg = "/dashboard,/skills"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies([{ name: "better-auth.session_token", value: "perf", url: origin }]);
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");
type Req = { url: string; encoded: number; at: number; cached: boolean; kind: string };
const reqs: Req[] = [];
const pending = new Map<string, { url: string; kind: string; at: number }>();
cdp.on("Network.requestWillBeSent", (e) => pending.set(e.requestId, { url: e.request.url, kind: e.type ?? "", at: e.timestamp }));
cdp.on("Network.responseReceived", (e) => {
  const p = pending.get(e.requestId);
  if (p && e.response.fromDiskCache) reqs.push({ url: p.url, encoded: 0, at: p.at, cached: true, kind: p.kind });
});
cdp.on("Network.requestServedFromCache", (e) => {
  const p = pending.get(e.requestId);
  if (p) { reqs.push({ url: p.url, encoded: 0, at: p.at, cached: true, kind: p.kind }); pending.delete(e.requestId); }
});
cdp.on("Network.loadingFinished", (e) => {
  const p = pending.get(e.requestId);
  if (!p) return;
  if (!reqs.some((r) => r.url === p.url && r.at === p.at)) reqs.push({ url: p.url, encoded: e.encodedDataLength, at: p.at, cached: false, kind: p.kind });
  pending.delete(e.requestId);
});
const isJs = (r: Req) => r.url.includes("/_next/static/chunks/") && r.url.endsWith(".js");
const isRsc = (r: Req) => r.url.startsWith(origin) && !r.url.includes("/_next/") && !r.url.includes("/api/") && r.kind !== "Document";

await page.goto(origin + first, { waitUntil: "load", timeout: 120_000 });
const loadedAt = Date.now();
const atLoad = reqs.length;
// Wait until the network has been quiet for 3 s (the warm runs after idle, concurrency 3).
for (let quietSince = Date.now(); Date.now() - quietSince < 3000 && Date.now() - loadedAt < 40_000; ) {
  await page.waitForTimeout(250);
  const last = reqs.at(-1)?.at ?? 0;
  if (reqs.length > 0 && Date.now() / 1000 - last < 3) quietSince = Date.now();
}
const after = reqs.slice(atLoad);
const warmJs = after.filter(isJs);
const warmRsc = after.filter(isRsc);
const total = (rs: Req[]) => Math.round(rs.reduce((a, r) => a + r.encoded, 0) / 1024);
console.log(`${first}: page load used ${reqs.slice(0, atLoad).filter(isJs).length} JS chunks; after load (idle prefetch + warming, ${Math.round((Date.now() - loadedAt) / 1000)}s): ${warmJs.length} JS chunks ${total(warmJs)}K on the wire, ${warmRsc.length} route prefetches ${total(warmRsc)}K`);
const warmedUrls = new Set(warmJs.map((r) => r.url));
const usedWarmed = new Set<string>();
for (const hop of hopsArg.split(",")) {
  const before = reqs.length;
  await page.goto(origin + hop, { waitUntil: "load", timeout: 120_000 });
  await page.waitForTimeout(1500);
  const js = reqs.slice(before).filter(isJs);
  const fetched = js.filter((r) => !r.cached && r.encoded > 0);
  for (const r of js) if (warmedUrls.has(r.url)) usedWarmed.add(r.url);
  console.log(`  hop ${hop}: ${js.length} JS chunks needed, ${js.length - fetched.length} from cache, ${fetched.length} downloaded (${total(fetched)}K)`);
}
const usedBytes = warmJs.filter((r) => usedWarmed.has(r.url)).reduce((a, r) => a + r.encoded, 0);
console.log(`warmed chunks used by these hops: ${usedWarmed.size} of ${warmedUrls.size} (${Math.round(usedBytes / 1024)}K of ${total(warmJs)}K on the wire)`);
await browser.close();
