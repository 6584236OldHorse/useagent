// Return-to-thread lab measurement: open /session/A, soft-navigate to /session/B via the
// sidebar link, come back to A the same way (the retained store reconnects with its
// cursors). Reports, per thread-events connection, the wire bytes over CDP and the
// replay duration. usage: bun perf-reconnect.ts <origin> <threadA> <threadB> [runs=3]
import { chromium } from "playwright-core";

const [origin = "http://localhost:3610", a = "", b = "", runsArg = "3"] = process.argv.slice(2);
const runs = Number(runsArg);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const rows: { first: number; back: number; backMs: number; backFrames: number }[] = [];

for (let i = 0; i < runs; i++) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: "better-auth.session_token", value: "perf", url: origin }]);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  const streams: { id: string; url: string; encoded: number; decoded: number; started: number; last: number; chunks: number }[] = [];
  cdp.on("Network.responseReceived", (e) => {
    if (/thread-events/.test(e.response.url)) streams.push({ id: e.requestId, url: e.response.url, encoded: 0, decoded: 0, started: e.timestamp, last: e.timestamp, chunks: 0 });
  });
  cdp.on("Network.dataReceived", (e) => {
    const s = streams.find((x) => x.id === e.requestId);
    if (!s) return;
    s.encoded += e.encodedDataLength; s.decoded += e.dataLength; s.last = e.timestamp; s.chunks++;
  });
  const quiet = async () => {
    const start = Date.now();
    for (;;) {
      await page.waitForTimeout(250);
      const open = streams.at(-1);
      if (open && Date.now() / 1000 - open.last > 1.5) return;
      if (Date.now() - start > 30_000) return;
    }
  };
  await page.goto(`${origin}/session/${a}`, { waitUntil: "load", timeout: 120_000 });
  await quiet();
  await page.click(`a[href="/session/${b}"]`);
  await page.waitForURL(`**/session/${b}`);
  await quiet();
  await page.click(`a[href="/session/${a}"]`);
  await page.waitForURL(`**/session/${a}`);
  await quiet();
  const toA = streams.filter((s) => s.url.includes(`/runs/${a}/`));
  const first = toA[0];
  const back = toA.at(-1);
  if (!first || !back) { console.log(`run ${i + 1}: no thread-events connection to A observed`); await context.close(); continue; }
  const row = { first: Math.round(first.decoded / 1024), back: Math.round(back.decoded / 1024), backMs: Math.round((back.last - back.started) * 1000), backFrames: back.chunks };
  rows.push(row);
  console.log(`run ${i + 1}: first open ${row.first}K, return ${row.back}K in ${row.backMs}ms (${toA.length} connections to A; return url ${new URL(back.url).search.slice(0, 120)})`);
  await context.close();
}
const med = (k: keyof (typeof rows)[number]) => { const v = rows.map((r) => r[k]).toSorted((x, y) => x - y); return `${v[Math.floor(v.length / 2)]} [${v[0]}-${v[v.length - 1]}]`; };
console.log(`\nreturn to ${a.slice(0, 8)} via ${b.slice(0, 8)} (n=${runs}) first-open ${med("first")}K, return ${med("back")}K, return replay ${med("backMs")}ms`);
await browser.close();
