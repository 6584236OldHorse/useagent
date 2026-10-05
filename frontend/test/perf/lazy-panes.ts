// Proof that a rail pane loads its code on first open: open the session, count the JS
// chunks requested up to a settled page, then click each named rail tab and report the
// JS chunks (and bytes) requested because of that click.
// usage: bun perf-lazy.ts <origin> <threadId> <tabLabel>[,<tabLabel>...]
import { chromium } from "playwright-core";

const [origin = "http://localhost:3620", thread = "", tabsArg = "Details"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies([{ name: "better-auth.session_token", value: "perf", url: origin }]);
const page = await context.newPage();
const js: { url: string; bytes: number; at: number }[] = [];
page.on("response", async (response) => {
  const url = response.url();
  if (!url.endsWith(".js") || !url.includes("/_next/")) return;
  let bytes = 0;
  try { bytes = (await response.body()).length; } catch { /* gone */ }
  js.push({ url: url.slice(url.lastIndexOf("/") + 1), bytes, at: Date.now() });
});
await page.goto(`${origin}/session/${thread}`, { waitUntil: "load", timeout: 120_000 });
await page.waitForTimeout(4000);
console.log(`first paint + settle: ${js.length} JS chunks, ${Math.round(js.reduce((a, j) => a + j.bytes, 0) / 1024)}K (uncompressed bytes)`);
for (const label of tabsArg.split(",")) {
  const before = js.length;
  const tab = page.locator("button").filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();
  if ((await tab.count()) === 0) { console.log(`tab "${label}": not present on this thread`); continue; }
  await tab.click();
  await page.waitForTimeout(2500);
  const loaded = js.slice(before);
  console.log(`tab "${label}": ${loaded.length} JS chunks loaded on open, ${Math.round(loaded.reduce((a, j) => a + j.bytes, 0) / 1024)}K: ${loaded.map((j) => `${j.url} ${Math.round(j.bytes / 1024)}K`).join(", ") || "(none)"}`);
}
await browser.close();
