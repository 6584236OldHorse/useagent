import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The React Server Components rule bun cannot reproduce at runtime: an export
 * of a "use client" module is a client reference inside a Server Component,
 * so calling it there throws on every request ("Attempted to call x() from
 * the server but x is on the client"). Every server page and layout under app/
 * may render such an export as an element, never call it. A helper a page
 * needs to call lives in a plain module (see agent/new/task-prefill.ts).
 */

const APP = resolve(import.meta.dir);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/^(page|layout)\.tsx$/.test(entry)) out.push(path);
  }
  return out;
}

const isClientModule = (source: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source);

function resolveRelative(from: string, specifier: string): string | null {
  const base = join(dirname(from), specifier);
  for (const candidate of [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next spelling
    }
  }
  return null;
}

/** The names a module hands out that are client references: every export of a
 *  client module, and, up to two levels deep, what a plain module re-exports
 *  from one ("export { x } from", "export * from"), so an intervening plain
 *  module cannot hide a client helper. */
function clientReferenceNames(target: string, depth = 0): { all: boolean; names: Set<string> } {
  const source = readFileSync(target, "utf8");
  if (isClientModule(source)) return { all: true, names: new Set() };
  const names = new Set<string>();
  let all = false;
  if (depth >= 2) return { all, names };
  for (const match of source.matchAll(/export\s*(\*|\{[^}]*\})\s*from\s*["'](\.[^"']*)["']/g)) {
    const via = resolveRelative(target, match[2] ?? "");
    if (!via) continue;
    const inner = clientReferenceNames(via, depth + 1);
    if (match[1] === "*") {
      if (inner.all) all = true;
      for (const name of inner.names) names.add(name);
      continue;
    }
    for (const raw of match[1]!.slice(1, -1).split(",")) {
      const exported = raw.split(/\s+as\s+/)[0]?.trim();
      const shown = raw.split(/\s+as\s+/).pop()?.trim();
      if (exported && shown && (inner.all || inner.names.has(exported))) names.add(shown);
    }
  }
  return { all, names };
}

const calls = (source: string, local: string) => new RegExp(`(?<![\\w.<])${local}\\s*\\(`).test(source);

/** Imports that are client references (directly or through re-exports) which
 *  the server module invokes as functions: named, default, and namespace
 *  imports (`ns.x(` counts as a call into the namespace). */
export function serverCallsIntoClientModules(source: string, file: string): string[] {
  if (isClientModule(source)) return [];
  const offences: string[] = [];
  for (const match of source.matchAll(/import\s+([^;]*?)\s+from\s*["'](\.[^"']*)["']/g)) {
    const clause = match[1] ?? "";
    const specifier = match[2] ?? "";
    if (clause.startsWith("type ")) continue;
    const target = resolveRelative(file, specifier);
    if (!target) continue;
    const client = clientReferenceNames(target);
    const namespace = clause.match(/\*\s+as\s+(\w+)/)?.[1];
    if (namespace && client.all && new RegExp(`(?<![\\w.])${namespace}\\.\\w+\\s*\\(`).test(source)) {
      offences.push(`${namespace} from ${specifier}`);
    }
    const defaultName = clause.match(/^(\w+)\s*(?:,|$)/)?.[1];
    if (defaultName && client.all && calls(source, defaultName)) offences.push(`${defaultName} from ${specifier}`);
    const named = clause.match(/\{([^}]*)\}/)?.[1] ?? "";
    for (const raw of named.split(",")) {
      if (raw.trim().startsWith("type ")) continue;
      const imported = raw.split(/\s+as\s+/)[0]?.trim();
      const local = raw.split(/\s+as\s+/).pop()?.trim();
      if (!imported || !local || !(client.all || client.names.has(imported))) continue;
      if (calls(source, local)) offences.push(`${local} from ${specifier}`);
    }
  }
  return offences;
}

test("a server page never calls an export of a client module (it would be a client reference, not a function)", () => {
  const offences = walk(APP).flatMap((file) =>
    serverCallsIntoClientModules(readFileSync(file, "utf8"), file).map((offence) => `${file.slice(APP.length + 1)}: ${offence}`),
  );
  expect(offences).toEqual([]);
});

test("the rule catches the shape that crashed the composer page once", () => {
  const page = join(APP, "(workspace)/agent/new/page.tsx");
  const source = 'import { FirstRunNotice } from "./first-run-notice";\nexport default function Page() { return <p>{FirstRunNotice({})}</p>; }\n';
  expect(serverCallsIntoClientModules(source, page)).toEqual(["FirstRunNotice from ./first-run-notice"]);
  const fine = 'import { FirstRunNotice } from "./first-run-notice";\nexport default function Page() { return <FirstRunNotice />; }\n';
  expect(serverCallsIntoClientModules(fine, page)).toEqual([]);
});

test("re-exports up to two levels, default and namespace imports cannot hide a client helper from the rule", () => {
  const dir = mkdtempSync(join(tmpdir(), "server-boundary-"));
  try {
    writeFileSync(join(dir, "client.tsx"), '"use client";\nexport default function Widget() { return null; }\nexport function helper() { return 1; }\nexport function other() { return 2; }\n');
    writeFileSync(join(dir, "plain.ts"), 'export { helper } from "./client";\nexport function honest() { return 3; }\n');
    writeFileSync(join(dir, "twice.ts"), 'export { helper as hidden } from "./plain";\n');
    writeFileSync(join(dir, "star.ts"), 'export * from "./client";\n');
    const page = join(dir, "page.tsx");
    const viaNamed = 'import { helper, honest } from "./plain";\nexport default function Page() { return <p>{helper()}{honest()}</p>; }\n';
    expect(serverCallsIntoClientModules(viaNamed, page)).toEqual(["helper from ./plain"]);
    const viaTwo = 'import { hidden } from "./twice";\nexport default function Page() { return <p>{hidden()}</p>; }\n';
    expect(serverCallsIntoClientModules(viaTwo, page)).toEqual(["hidden from ./twice"]);
    const viaStar = 'import { other as renamed } from "./star";\nexport default function Page() { return <p>{renamed()}</p>; }\n';
    expect(serverCallsIntoClientModules(viaStar, page)).toEqual(["renamed from ./star"]);
    const viaDefault = 'import Widget from "./client";\nexport default function Page() { return <p>{Widget()}</p>; }\n';
    expect(serverCallsIntoClientModules(viaDefault, page)).toEqual(["Widget from ./client"]);
    const viaNamespace = 'import * as ui from "./client";\nexport default function Page() { return <p>{ui.helper()}</p>; }\n';
    expect(serverCallsIntoClientModules(viaNamespace, page)).toEqual(["ui from ./client"]);
    const asElements = 'import Widget, { helper } from "./client";\nimport * as ui from "./client";\nexport default function Page() { return <><Widget /><helper /><ui.other /></>; }\n';
    expect(serverCallsIntoClientModules(asElements, page)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
