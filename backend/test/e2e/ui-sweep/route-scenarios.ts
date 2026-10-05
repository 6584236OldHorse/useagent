import type { Browser } from "playwright-core";
import { FE, TAG, beApi, newPage, shot, verdictOf, type Result } from "./harness";

// Route-level scenarios seed real fixtures tagged `uisweep`, then assert that
// the corresponding page renders real data or an honest empty/error state.

// ── Scenario 12: Skills — list + detail sections + "Run" preselect deep-link ──
export async function s12_skills(browser: Browser): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  const marker = crypto.randomUUID().slice(0, 6);
  const name = `${TAG}-skill ${marker}`;
  const overview = `uisweep overview line ${marker}`;
  try {
    // Seed a real skill (dev-org) with all three sections so "detail" has content.
    const created = await beApi("/api/skills", {
      body: {
        name,
        description: `uisweep skill fixture ${marker}`,
        tags: ["uisweep"],
        sections: { overview: [overview], procedure: ["do the thing"], verify: ["check the thing"] },
      },
    });
    const skillId = created.body?.id as string | undefined;
    checks.push({ name: "skills: fixture created via POST /api/skills", ok: created.status === 201 && !!skillId, note: `http=${created.status} id=${skillId?.slice(0, 8)}` });

    await page.goto(`${FE}/skills`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    checks.push({ name: "skills: page heading present", ok: (await page.getByRole("heading", { name: /^Skills$/ }).count()) > 0 });
    // List: the seeded skill's row is on the page (real data, not a mock). The
    // library is a list of <li> rows: name button + description caption + Run.
    const card = page.locator("li", { hasText: name }).first();
    checks.push({ name: "skills: seeded skill renders in the library (real data)", ok: (await card.count()) > 0, note: name });
    checks.push({ name: "skills: row caption shows the seeded description", ok: (await card.getByText(`uisweep skill fixture ${marker}`).count()) > 0 });
    // Detail: the name opens the detail view, which renders the sections.
    await card.getByRole("button", { name }).first().click().catch(() => {});
    await page.waitForTimeout(600);
    checks.push({ name: "skills: detail section content visible (overview line)", ok: (await page.getByText(overview).count()) > 0, note: overview });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    // Run preselect: the row's Run button deep-links to /agent/new?skill=<id>,
    // and the New Task composer opens with that playbook chosen. Match the
    // post-click "Ran" state too.
    const runBtn = card.getByRole("button", { name: /^Run( skill)?$|^Ran$/i }).first();
    let preselected = false;
    if ((await runBtn.count()) > 0 && skillId) {
      await runBtn.click();
      await page.waitForURL(/\/agent\/new\?skill=/, { timeout: 15_000 }).catch(() => {});
      const url = page.url();
      checks.push({ name: "skills: Run deep-links to /agent/new?skill=<id>", ok: url.includes(`skill=${skillId}`), note: url.slice(-60) });
      await page.waitForTimeout(1200);
      // The playbook picker trigger reflects the preselected skill name.
      const picker = page.locator('[aria-label="Select playbook"]').first();
      const pickerTxt = (await picker.textContent().catch(() => "")) ?? "";
      preselected = pickerTxt.includes(name) || (await page.getByText(name).count()) > 0;
      checks.push({ name: "skills: New Task composer opens with the skill preselected", ok: preselected, note: pickerTxt.slice(0, 50) });
    } else {
      checks.push({ name: "skills: Run button present on the seeded card", ok: false, note: "no Run button found" });
    }
    return verdictOf("12. Skills (list / detail sections / Run preselect deep-link)", checks);
  } catch (e) {
    await shot(page, "s12-skills-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("12. Skills", checks);
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Scenario 13: Knowledge — real record renders + Add modal honest states ────
export async function s13_knowledge(browser: Browser): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  const marker = crypto.randomUUID().slice(0, 8);
  const token = `${TAG}kb${marker}`;
  try {
    // Seed a real knowledge record (keyword-retrievable; distill stubs w/o keys).
    const ing = await beApi("/api/knowledge/ingest", {
      body: {
        meta: { source_type: "document", external_id: token, connector_instance_id: "uisweep:web", source_url: "https://example.com/uisweep", domain: "uisweep" },
        text: `uisweep knowledge fixture ${token}. The uisweep convention is to tag every test row with ${token} so cleanup deletes only ours.`,
      },
    });
    const stored = ing.status === 200 && (ing.body?.status === "stored" || ing.body?.status === "skipped");
    checks.push({ name: "knowledge: fixture ingested (stored/skipped, honest status)", ok: stored, note: `http=${ing.status} status=${ing.body?.status}` });

    await page.goto(`${FE}/knowledge`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1400);
    checks.push({ name: "knowledge: page heading present", ok: (await page.getByRole("heading", { name: /^Knowledge$/ }).count()) > 0 });
    // Real record appears (search for its unique token to avoid ambiguity).
    const search = page.locator('[aria-label="Search knowledge"]').first();
    if ((await search.count()) > 0) {
      await search.fill(token);
      await page.waitForTimeout(1400);
    }
    const tokenSeen = (await page.getByText(new RegExp(token)).count()) > 0;
    checks.push({ name: "knowledge: the seeded record renders (real data, by unique token)", ok: tokenSeen, note: token });

    // Add modal: opens with the real form fields — no fabricated success string.
    await page.getByRole("button", { name: /Add knowledge/i }).first().click().catch(() => {});
    await page.waitForTimeout(600);
    // The dialog's fields are label-bound (Name, Trigger, Content, Folder), so
    // find them by accessible label rather than a fixed id.
    const dialog = page.getByRole("dialog").first();
    const hasName = (await dialog.getByLabel("Name", { exact: true }).count()) > 0;
    const hasContent = (await dialog.getByLabel("Content", { exact: true }).count()) > 0;
    checks.push({ name: "knowledge: Add modal exposes real name + content fields", ok: hasName && hasContent, note: `name=${hasName} content=${hasContent}` });
    // Honesty: before any submit, no premature "saved/success" claim is shown.
    const body = await page.locator("body").innerText();
    const falseSuccess = /\b(saved|success|added to knowledge)\b/i.test(body) && !/Save$/m.test(body);
    checks.push({ name: "knowledge: no fabricated success before submit (deferred-honest)", ok: !falseSuccess });
    return verdictOf("13. Knowledge (real record render / Add modal honest states)", checks);
  } catch (e) {
    await shot(page, "s13-knowledge-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("13. Knowledge", checks);
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Scenario 14: Wiki — published document renders + honest empty branch ──────
export async function s14_wiki(browser: Browser): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  const marker = crypto.randomUUID().slice(0, 6);
  const title = `${TAG}-wiki ${marker}`;
  const bodyMarker = `uisweep-wiki-body-${marker}`;
  try {
    // Baseline: read the current published set to know the empty vs non-empty branch.
    const before = await beApi("/api/knowledge/documents?status=published");
    const beforeCount = (before.body?.documents ?? []).length as number;

    await page.goto(`${FE}/wiki`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    checks.push({ name: "wiki: page heading present", ok: (await page.getByRole("heading", { name: /^Wiki$/ }).count()) > 0 });
    // Honest empty vs list — never a fabricated placeholder.
    const emptyShown = (await page.getByText(/No published pages yet/i).count()) > 0;
    checks.push({
      name: "wiki: honest state — empty copy iff zero published (no fabrication)",
      ok: beforeCount === 0 ? emptyShown : !emptyShown,
      note: `publishedBefore=${beforeCount} emptyShown=${emptyShown}`,
    });

    // Create + publish a real document, then assert it renders on the wiki.
    const doc = await beApi("/api/knowledge/documents", { body: { title, content: `# ${title}\n\n${bodyMarker}` } });
    const docId = doc.body?.document?.id as string | undefined;
    checks.push({ name: "wiki: document created (draft)", ok: !!docId, note: `http=${doc.status} id=${docId?.slice(0, 8)}` });
    if (docId) {
      const pub = await beApi(`/api/knowledge/documents/${docId}/publish`, { body: {} });
      checks.push({ name: "wiki: document published", ok: pub.status === 200 && pub.body?.document?.status === "published", note: `status=${pub.body?.document?.status}` });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      checks.push({ name: "wiki: published document title renders", ok: (await page.getByText(title).count()) > 0, note: title });
      checks.push({ name: "wiki: published document body renders (real content)", ok: (await page.getByText(bodyMarker).count()) > 0, note: bodyMarker });
    }
    return verdictOf("14. Wiki (published render / honest empty branch)", checks);
  } catch (e) {
    await shot(page, "s14-wiki-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("14. Wiki", checks);
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Scenario 15: Schedules — create via the modal + list row (created disabled) ─
export async function s15_schedules(browser: Browser): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  const marker = crypto.randomUUID().slice(0, 6);
  const name = `${TAG}-sched ${marker}`;
  try {
    // Schedules were renamed Automations; /agent/schedules redirects here.
    await page.goto(`${FE}/agent/automations`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    checks.push({ name: "schedules: page heading present", ok: (await page.getByRole("heading", { name: /^Automations$/ }).count()) > 0 });

    // Open the New automation modal and fill it (cron validates locally, no LLM).
    await page.getByRole("button", { name: /New automation/i }).first().click().catch(() => {});
    await page.waitForTimeout(500);
    const dialog = page.getByRole("dialog").first();
    checks.push({ name: "schedules: 'starts paused' copy present in the create modal", ok: (await dialog.getByText(/New automations start paused/i).count()) > 0 });
    const nameInput = dialog.getByLabel("What should run?", { exact: true }).first();
    const cronInput = dialog.getByLabel("Cron expression", { exact: true }).first();
    const promptInput = dialog.locator("#automation-instructions").first();
    // Hydration-safe fills.
    for (let i = 0; i < 20; i++) {
      await nameInput.fill(name);
      await cronInput.fill("0 9 * * 1");
      await promptInput.fill(`uisweep scheduled prompt ${marker}`);
      if ((await nameInput.inputValue()) === name) break;
      await page.waitForTimeout(150);
    }
    const createBtn = dialog.getByRole("button", { name: /^Create automation$|Saving/ }).first();
    await createBtn.click().catch(() => {});
    // The new row lands in the list.
    const row = page.locator("article", { hasText: name }).first();
    await row.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    checks.push({ name: "schedules: created schedule appears in the list (real row)", ok: (await row.count()) > 0, note: name });
    checks.push({ name: "schedules: new row shows cron + paused status (honest, created off)", ok: (await row.getByText("0 9 * * 1").count()) > 0 && (await row.getByText(/^Paused$/).count()) > 0 });
    // Confirm it persisted server-side too.
    const list = await beApi("/api/schedules");
    const persisted = (list.body?.schedules ?? []).some((s: any) => s.name === name && s.enabled === false);
    checks.push({ name: "schedules: persisted server-side, enabled=false", ok: persisted, note: `count=${(list.body?.schedules ?? []).length}` });
    return verdictOf("15. Schedules (create via modal / list row / created-disabled)", checks);
  } catch (e) {
    await shot(page, "s15-schedules-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("15. Schedules", checks);
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Scenario 16: Workspace — real Limits card + fleet run links → /session/ ────
export async function s16_workspace(browser: Browser, wf: string): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  try {
    // Ground truth from the same APIs the page reads.
    const fleet = (await beApi("/api/fleet")).body ?? {};
    const runs = (await beApi("/api/runs")).body?.runs ?? [];
    // The workspace overview merged into /dashboard (/agent/workspace redirects).
    await page.goto(`${FE}/dashboard`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    checks.push({ name: "workspace: page heading present", ok: (await page.getByRole("heading", { name: /^Welcome back$/ }).count()) > 0 });

    // Limits card: the token-burn panel shows REAL per-model burn or the honest empty.
    checks.push({ name: "workspace: Limits section heading present", ok: (await page.getByRole("heading", { name: /^Limits$/ }).count()) > 0 });
    const modelsHeading = (await page.getByText(/Token burn · today/).count()) > 0;
    checks.push({ name: "workspace: 'Token burn · today' panel present", ok: modelsHeading });
    const hasModelRows = (fleet.models ?? []).length > 0;
    const emptyBurn = (await page.getByText(/No model runs yet today/i).count()) > 0;
    const tokensToday = (await page.getByText(/\btokens\b/).count()) > 0;
    checks.push({
      name: "workspace: Limits reflects real /api/fleet (rows+totals, or honest empty)",
      ok: hasModelRows ? tokensToday && !emptyBurn : emptyBurn,
      note: `apiModels=${(fleet.models ?? []).length} tokensToday=${tokensToday} emptyBurn=${emptyBurn}`,
    });

    // Fleet run links point at /session/{id} — the audit-fix contract (#79).
    const sessionLinks = page.locator('a[href^="/session/"]');
    const linkCount = await sessionLinks.count();
    // Expand lanes so collapsed run rows mount, then re-count.
    const laneButtons = page.locator('button[aria-expanded]');
    const nLanes = await laneButtons.count();
    for (let i = 0; i < nLanes; i++) await laneButtons.nth(i).click().catch(() => {});
    await page.waitForTimeout(600);
    const linksAfter = await page.locator('a[href^="/session/"]').count();
    const noDeadRunLinks = (await page.locator('a[href^="/agent/runs/"]').count()) === 0;
    if (runs.length > 0) {
      checks.push({ name: "workspace: fleet run rows link to /session/{id} (not the dead /agent/runs/)", ok: linksAfter > 0 && noDeadRunLinks, note: `sessionLinks=${linksAfter} runs=${runs.length}` });
      // The href resolves to a real run id.
      const firstHref = await page.locator('a[href^="/session/"]').first().getAttribute("href").catch(() => null);
      const realId = firstHref?.split("/session/")[1] ?? "";
      const isRealRun = runs.some((r: any) => r.id === realId);
      checks.push({ name: "workspace: a run link targets a REAL run id from /api/runs", ok: isRealRun, note: `href=${firstHref}` });
    } else {
      checks.push({ name: "workspace: no runs today ⇒ lanes honestly empty (no fabricated links)", ok: linkCount === 0 && noDeadRunLinks, note: `links=${linkCount}` });
    }
    await shot(page, "s16-workspace");
    return verdictOf("16. Workspace (real Limits card / run links → /session/)", checks, `warm=${wf}`);
  } catch (e) {
    await shot(page, "s16-workspace-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("16. Workspace", checks);
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Scenario 17: Live Artifacts — card link → /session/ or honest empty ───────
export async function s17_artifacts(browser: Browser): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  try {
    const runs = (await beApi("/api/runs")).body?.runs ?? [];
    await page.goto(`${FE}/agent/artifacts`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    checks.push({ name: "artifacts: 'Artifacts' heading present", ok: (await page.getByRole("heading", { name: /^Artifacts$/ }).count()) > 0 });

    // Cards are plain links back to their run's session, not <article> elements.
    const cards = page.locator('a[href^="/session/"]');
    const cardCount = await cards.count();
    const emptyShown = (await page.getByText(/No artifacts yet/i).count()) > 0;
    if (cardCount > 0 && !emptyShown) {
      // Each card links back to its run's session.
      const link = page.locator('a[href^="/session/"]').first();
      const href = (await link.getAttribute("href").catch(() => null)) ?? "";
      const runId = href.split("/session/")[1] ?? "";
      const isRealRun = runs.some((r: any) => r.id === runId);
      checks.push({ name: "artifacts: card links to /session/{runId} (real run)", ok: !!href && isRealRun, note: `href=${href}` });
    } else {
      // Honest empty: the CTA points at /agent/new — no fabricated gallery.
      const cta = (await page.locator('a[href="/agent/new"]').count()) > 0;
      checks.push({ name: "artifacts: honest empty state ('No artifacts yet' + Start a run CTA)", ok: emptyShown && cta, note: `empty=${emptyShown} cta=${cta}` });
    }
    await shot(page, "s17-artifacts");
    return verdictOf("17. Live Artifacts (card link → /session/ or honest empty)", checks);
  } catch (e) {
    await shot(page, "s17-artifacts-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("17. Live Artifacts", checks);
  } finally {
    await page.close().catch(() => {});
  }
}
