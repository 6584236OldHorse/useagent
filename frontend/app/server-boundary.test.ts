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
 *  client module, and, one level deep, what a plain module re-exports from one
 *  ("export { x } from" or "export * from"), so an intervening plain module
 *  cannot hide a client helper. */
function clientReferenceNames(target: string): { all: boolean; names: Set<string> } {
  const source = readFileSync(target, "utf8");
  if (isClientModule(source)) return { all: true, names: new Set() };
  const names = new Set<string>();
  let all = false;
  for (const match of source.matchAll(/export\s*(\*|\{[^}]*\})\s*from\s*["'](\.[^"']*)["']/g)) {
    const via = resolveRelative(target, match[2] ?? "");
    if (!via || !isClientModule(readFileSync(via, "utf8"))) continue;
    if (match[1] === "*") all = true;
    else for (const raw of match[1]!.slice(1, -1).split(",")) {
      const name = raw.split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return { all, names };
}

/** Named imports that are client references (directly or through one plain
 *  re-export) which the server module invokes as functions. */
export function serverCallsIntoClientModules(source: string, file: string): string[] {
  if (isClientModule(source)) return [];
  const offences: string[] = [];
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']*)["']/g)) {
    const target = resolveRelative(file, match[2] ?? "");
    if (!target) continue;
    const client = clientReferenceNames(target);
    for (const raw of (match[1] ?? "").split(",")) {
      if (raw.trim().startsWith("type ")) continue;
      const imported = raw.split(/\s+as\s+/)[0]?.trim();
      const local = raw.split(/\s+as\s+/).pop()?.trim();
      if (!imported || !local || !(client.all || client.names.has(imported))) continue;
      if (new RegExp(`(?<![\\w.<])${local}\\s*\\(`).test(source)) offences.push(`${local} from ${match[2]}`);
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

test("the rule catches the shape that crashed the composer page", () => {
  const page = join(APP, "(workspace)/agent/new/page.tsx");
  const source = 'import { FirstRunGate } from "./first-run-gate";\nexport default function Page() { return <FirstRunGate prefilled={FirstRunGate({ children: null })} />; }\n';
  expect(serverCallsIntoClientModules(source, page)).toEqual(["FirstRunGate from ./first-run-gate"]);
  const fine = 'import { FirstRunGate } from "./first-run-gate";\nimport { taskPrefilled } from "./task-prefill";\nexport default function Page() { return <FirstRunGate prefilled={taskPrefilled({ repo: null, prompt: "" })} />; }\n';
  expect(serverCallsIntoClientModules(fine, page)).toEqual([]);
});

test("one plain re-export cannot hide a client helper from the rule", () => {
  const dir = mkdtempSync(join(tmpdir(), "server-boundary-"));
  try {
    writeFileSync(join(dir, "client.tsx"), '"use client";\nexport function helper() { return 1; }\nexport function other() { return 2; }\n');
    writeFileSync(join(dir, "plain.ts"), 'export { helper } from "./client";\nexport function honest() { return 3; }\n');
    writeFileSync(join(dir, "star.ts"), 'export * from "./client";\n');
    const page = join(dir, "page.tsx");
    const viaNamed = 'import { helper, honest } from "./plain";\nexport default function Page() { return <p>{helper()}{honest()}</p>; }\n';
    expect(serverCallsIntoClientModules(viaNamed, page)).toEqual(["helper from ./plain"]);
    const viaStar = 'import { other as renamed } from "./star";\nexport default function Page() { return <p>{renamed()}</p>; }\n';
    expect(serverCallsIntoClientModules(viaStar, page)).toEqual(["renamed from ./star"]);
    const asElement = 'import { helper } from "./plain";\nexport default function Page() { return <helper />; }\n';
    expect(serverCallsIntoClientModules(asElement, page)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
