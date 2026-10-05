// How long after a client-side navigation into a thread the spend chip's read is issued:
// open /dashboard (the org stream opens there), then click the sidebar link to a thread
// and measure the time from the navigation to GET /api/spend. usage:
//   bun perf-nav-spend.ts <origin> <threadId> [runs=3]
import { chromium } from "playwright-core";

const [origin = "http://localhost:3620", thread = "", runsArg = "3"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results: number[] = [];
for (let i = 0; i < Number(runsArg); i++) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: "better-auth.session_token", value: "perf", url: origin }]);
  const page = await context.newPage();
  await page.goto(`${origin}/dashboard`, { waitUntil: "load", timeout: 120_000 });
  await page.waitForTimeout(2500);
  const spendAt: number[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/spend") spendAt.push(Date.now());
  });
  const navigatedAt = Date.now();
  await page.click(`a[href="/session/${thread}"]`);
  await page.waitForURL(`**/session/${thread}`);
  await page.waitForTimeout(3000);
  const first = spendAt[0];
  const ms = first === undefined ? -1 : first - navigatedAt;
  results.push(ms);
  console.log(`run ${i + 1}: spend read ${ms < 0 ? "never issued in 3 s" : `${ms} ms after the navigation`} (${spendAt.length} spend reads)`);
  await context.close();
}
const sorted = results.toSorted((a, b) => a - b);
console.log(`median ${sorted[Math.floor(sorted.length / 2)]} ms [${sorted[0]}-${sorted[sorted.length - 1]}]`);
await browser.close();
