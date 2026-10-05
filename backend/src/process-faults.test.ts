import { expect, test } from "bun:test";
import { join } from "node:path";

/** Run `body` in a fresh Bun process with the server's fault handlers installed. */
async function withHandlers(body: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const handlers = JSON.stringify(join(import.meta.dir, "process-faults.ts"));
  const proc = Bun.spawn(
    [process.execPath, "-e", `import { installProcessFaultHandlers } from ${handlers};\ninstallProcessFaultHandlers();\n${body}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("an unhandled rejection is logged and the process keeps serving", async () => {
  const out = await withHandlers(
    `void Promise.reject(new Error("db blip")); setTimeout(() => console.log("still serving"), 50);`,
  );
  expect(out.stderr).toContain("unhandled promise rejection");
  expect(out.stdout).toContain("still serving");
  expect(out.code).toBe(0);
});

test("an uncaught exception is logged and the process exits for a clean restart", async () => {
  const out = await withHandlers(
    `setTimeout(() => { throw new Error("half-updated state"); }, 0); setTimeout(() => console.log("kept running"), 200);`,
  );
  expect(out.stderr).toContain("uncaught exception");
  expect(out.stdout).not.toContain("kept running");
  expect(out.code).toBe(1);
});
