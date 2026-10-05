// Compile the runner for every platform the desktop shell ships on. The
// release asset names are part of the contract with the shell.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const TARGETS = [
  { target: "bun-darwin-arm64", asset: "useagent-runner-darwin-arm64" },
  { target: "bun-darwin-x64", asset: "useagent-runner-darwin-x64" },
  { target: "bun-linux-x64", asset: "useagent-runner-linux-x64" },
  { target: "bun-windows-x64", asset: "useagent-runner-win-x64.exe" },
] as const;

const only = process.argv.slice(2);
const outDir = join(import.meta.dir, "..", "dist");
await mkdir(outDir, { recursive: true });
for (const { target, asset } of TARGETS) {
  if (only.length > 0 && !only.some((name) => asset.includes(name) || target.includes(name))) continue;
  const outfile = join(outDir, asset);
  const proc = Bun.spawn(["bun", "build", "--compile", `--target=${target}`, "--outfile", outfile, join(import.meta.dir, "..", "src", "main.ts")], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await proc.exited) !== 0) {
    process.stderr.write(`build failed for ${target}\n`);
    process.exit(1);
  }
  process.stdout.write(`${asset}\n`);
}
