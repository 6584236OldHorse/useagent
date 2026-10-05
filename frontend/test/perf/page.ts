// Lab measurement of one route on the local prod build (performance skill, MEASUREMENT.md):
// navigation timing (TTFB), FCP + LCP from PerformanceObserver (single-session lab
// values), TBT = sum of long-task time over 50 ms from navigation until the stream
// replay settles, JS transfer bytes, the API request log with duplicates, and the
// thread-events SSE wire bytes counted over CDP (an open EventSource never lands in
// resource timing). Conditions: headless system Chrome, 1440x900, no throttling,
// cold cache per run (new context), dev-org cookie.
// usage: bun perf-page.ts <origin> <path> [runs=3]
import { chromium } from "playwright-core";

const [origin = "http://localhost:3610", path = "/agent/new", runsArg = "3"] = process.argv.slice(2);
const runs = Number(runsArg);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const version = browser.version();
const results: Record<string, number>[] = [];

for (let i = 0; i < runs; i++) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: "better-auth.session_token", value: "perf", url: origin }]);
  const page = await context.newPage();
  await page.addInitScript(() => {
    const w = window as unknown as { __perf: { fcp: number; lcp: number; tbt: number; cls: number } };
    w.__perf = { fcp: 0, lcp: 0, tbt: 0, cls: 0 };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name === "first-contentful-paint") w.__perf.fcp = e.startTime;
    }).observe({ type: "paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__perf.lcp = e.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__perf.tbt += Math.max(0, e.duration - 50);
    }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const shift = e as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (!shift.hadRecentInput) w.__perf.cls += shift.value ?? 0;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  const sseBytes = new Map<string, { url: string; encoded: number; decoded: number; started: number; last: number; done: boolean }>();
  const requestUrls = new Map<string, string>();
  cdp.on("Network.requestWillBeSent", (e) => {
    requestUrls.set(e.requestId, e.request.url);
  });
  cdp.on("Network.responseReceived", (e) => {
    if (/thread-events/.test(e.response.url)) sseBytes.set(e.requestId, { url: e.response.url, encoded: 0, decoded: 0, started: e.timestamp, last: e.timestamp, done: false });
  });
  cdp.on("Network.dataReceived", (e) => {
    const s = sseBytes.get(e.requestId);
    if (!s) return;
    s.encoded += e.encodedDataLength;
    s.decoded += e.dataLength;
    s.last = e.timestamp;
  });
  const api: { method: string; url: string; status: number; bytes: number }[] = [];
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin || !url.pathname.startsWith("/api/")) return;
    let bytes = 0;
    if (!/thread-events|\/changes$/.test(url.pathname)) {
      try { bytes = (await response.body()).length; } catch { /* stream */ }
    }
    api.push({ method: response.request().method(), url: url.pathname + url.search, status: response.status(), bytes });
  });
  const t0 = Date.now();
  await page.goto(origin + path, { waitUntil: "load", timeout: 120_000 });
  // Settle: wait until the SSE has been quiet for 1.5 s (replay finished) or 20 s.
  const settleStart = Date.now();
  for (;;) {
    await page.waitForTimeout(250);
    const streams = [...sseBytes.values()];
    const quiet = streams.length > 0 && streams.every((s) => (Date.now() / 1000 - s.last) > 1.5);
    if (quiet || Date.now() - settleStart > 20_000) break;
  }
  const wall = Date.now() - t0;
  const perf = await page.evaluate(() => (window as unknown as { __perf: Record<string, number> }).__perf);
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    return { ttfb: n.responseStart, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd };
  });
  const js = await page.evaluate(() =>
    performance.getEntriesByType("resource").filter((r) => r.name.endsWith(".js")).reduce((a, r) => a + (r as PerformanceResourceTiming).transferSize, 0),
  );
  const sse = [...sseBytes.values()];
  const sseEncoded = sse.reduce((a, s) => a + s.encoded, 0);
  const sseDecoded = sse.reduce((a, s) => a + s.decoded, 0);
  const sseMs = sse.length ? Math.round(Math.max(...sse.map((s) => (s.last - s.started) * 1000))) : 0;
  const counts = new Map<string, number>();
  for (const r of api) { const k = `${r.method} ${r.url.replace(/\?.*$/, "")}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
  const dupes = [...counts].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
  const row = { ttfb: Math.round(nav.ttfb), fcp: Math.round(perf.fcp), lcp: Math.round(perf.lcp), dcl: Math.round(nav.dcl), load: Math.round(nav.load), tbt: Math.round(perf.tbt), cls: Number(perf.cls.toFixed(3)), js: Math.round(js / 1024), api: api.length, sseEncoded: Math.round(sseEncoded / 1024), sseDecoded: Math.round(sseDecoded / 1024), sseMs, wall };
  results.push(row);
  console.log(`run ${i + 1}: ${JSON.stringify(row)}`);
  if (i === 0) {
    for (const r of api) console.log(`  ${r.status} ${r.method} ${r.url}${r.bytes ? ` ${Math.round(r.bytes / 1024)}K` : ""}`);
    if (dupes.length) console.log(`  DUPLICATES: ${dupes.join("; ")}`);
    for (const s of sse) console.log(`  SSE ${new URL(s.url).pathname} encoded=${Math.round(s.encoded / 1024)}K decoded=${Math.round(s.decoded / 1024)}K`);
  }
  await context.close();
}
const median = (k: string) => { const v = results.map((r) => r[k] ?? 0).toSorted((a, b) => a - b); return { median: v[Math.floor(v.length / 2)], min: v[0], max: v[v.length - 1] }; };
console.log(`\n${path} on ${origin} (Chrome ${version}, 1440x900, no throttling, cold cache, n=${runs}) median [min-max]:`);
for (const k of ["ttfb", "fcp", "lcp", "tbt", "cls", "js", "api", "sseEncoded", "sseDecoded", "sseMs", "wall"]) { const m = median(k); console.log(`  ${k.padEnd(11)} ${m.median} [${m.min}-${m.max}]`); }
await browser.close();
