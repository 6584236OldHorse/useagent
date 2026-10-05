import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

/** Named imports from sibling client modules that the server module invokes as functions. */
export function serverCallsIntoClientModules(source: string, file: string): string[] {
  if (isClientModule(source)) return [];
  const offences: string[] = [];
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']*)["']/g)) {
    const target = resolveRelative(file, match[2] ?? "");
    if (!target || !isClientModule(readFileSync(target, "utf8"))) continue;
    for (const raw of (match[1] ?? "").split(",")) {
      const name = raw.replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (!name || raw.trim().startsWith("type ")) continue;
      if (new RegExp(`(?<![\\w.<])${name}\\s*\\(`).test(source)) offences.push(`${name} from ${match[2]}`);
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
