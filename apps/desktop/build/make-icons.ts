// Regenerates every icon asset in this directory from icon.svg.
// Run: bun apps/desktop/build/make-icons.ts
// Needs rsvg-convert (brew install librsvg / apt install librsvg2-bin) or magick on PATH;
// icon.icns additionally needs macOS iconutil and is skipped elsewhere.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = import.meta.dir;
const svg = readFileSync(join(dir, "icon.svg"), "utf8");
const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];

function run(cmd: string[], stdin?: string) {
  const proc = Bun.spawnSync(cmd, { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`${cmd[0]} failed: ${proc.stderr.toString()}`);
}

function render(size: number, out: string) {
  // At 32 px and below the 23 px stroke thins to under a pixel, so small sizes get a heavier stroke.
  const input = size <= 32 ? svg.replace('stroke-width="10"', 'stroke-width="18"') : svg;
  if (Bun.which("rsvg-convert")) return run(["rsvg-convert", "-w", `${size}`, "-h", `${size}`, "-o", out], input);
  if (Bun.which("magick")) return run(["magick", "-background", "none", "-size", `${size}x${size}`, "svg:-", out], input);
  throw new Error("no rasteriser found: install rsvg-convert or magick");
}

// ICO container: 6-byte header, 16-byte directory entries, then PNG payloads (valid on Vista and later).
function ico(pngs: { size: number; data: Uint8Array }[]) {
  const header = new DataView(new ArrayBuffer(6 + 16 * pngs.length));
  header.setUint16(2, 1, true); // type: icon
  header.setUint16(4, pngs.length, true);
  let offset = header.byteLength;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.setUint8(e, size === 256 ? 0 : size);
    header.setUint8(e + 1, size === 256 ? 0 : size);
    header.setUint16(e + 4, 1, true); // colour planes
    header.setUint16(e + 6, 32, true); // bits per pixel
    header.setUint32(e + 8, data.byteLength, true);
    header.setUint32(e + 12, offset, true);
    offset += data.byteLength;
  });
  return Buffer.concat([new Uint8Array(header.buffer), ...pngs.map((p) => p.data)]);
}

mkdirSync(join(dir, "icons"), { recursive: true });
for (const size of sizes) render(size, join(dir, "icons", `${size}x${size}.png`));
const png = (size: number) => readFileSync(join(dir, "icons", `${size}x${size}.png`));
writeFileSync(join(dir, "icon.png"), png(1024));
writeFileSync(join(dir, "icon.ico"), ico([16, 32, 48, 64, 128, 256].map((size) => ({ size, data: png(size) }))));

if (Bun.which("iconutil")) {
  const scratch = mkdtempSync(join(tmpdir(), "useagent-icons-"));
  const iconset = join(scratch, "icon.iconset");
  mkdirSync(iconset);
  for (const base of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${base}x${base}.png`), png(base));
    writeFileSync(join(iconset, `icon_${base}x${base}@2x.png`), png(base * 2));
  }
  run(["iconutil", "-c", "icns", iconset, "-o", join(dir, "icon.icns")]);
  rmSync(scratch, { recursive: true });
} else {
  console.warn("iconutil not found (macOS only): icon.icns not regenerated");
}
console.log("icons regenerated from icon.svg");
