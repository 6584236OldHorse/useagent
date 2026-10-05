import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { desktopToolchainCommand } from "./native-image";
import { sandboxRuntimeLayout } from "./provider";

const LOCAL_SANDBOX = new URL("../../../deploy/local-sandbox/", import.meta.url);

/** The recipe keeps root rights for Xorg. A container without CAP_IPC_OWNER (Docker's default set) lets a
 *  root Xorg attach none of the shared-memory segments x11vnc creates as uid 1000, and the stream never
 *  starts; this base runs Xorg as the user instead. */

/** The local base image carries the desktop the recipe's desktop step installs on the cloud
 *  bases. That step's probe exits it before it writes anything once the stack is complete, so
 *  the base must also carry every file the step would have written. */
describe("local sandbox base image", () => {
  const recipe = desktopToolchainCommand(sandboxRuntimeLayout("local"));

  test("installs every package the recipe's desktop step installs", async () => {
    const dockerfile = await readFile(new URL("Dockerfile.base", LOCAL_SANDBOX), "utf8");
    const block = dockerfile.match(/apt-get install -y --no-install-recommends \\\n([\s\S]*?)\n\s*&& mkdir/);
    const installed = new Set(block?.[1]?.split(/\s+/).filter((token) => token && token !== "\\") ?? []);
    const wanted = recipe.match(/apt-get install -y -qq --no-install-recommends ([^\n]+)/)?.[1]?.split(" ") ?? [];
    expect(wanted.length).toBeGreaterThan(0);
    expect(wanted.filter((name) => !installed.has(name))).toEqual([]);
    expect(installed.has("chromium")).toBe(true);
  });

  test("carries every file the recipe's desktop step writes, byte for byte", async () => {
    const written = [...recipe.matchAll(/tee '([^']+)' >\/dev\/null <<'USEAGENT_EOF'\n([\s\S]*?)\nUSEAGENT_EOF\n/g)];
    expect(written.map(([, path]) => path)).toContain("/etc/X11/xorg.conf.d/10-virtual-display.conf");
    expect(written.map(([, path]) => path)).toContain("/etc/X11/Xwrapper.config");
    for (const [, path, text] of written) {
      expect(await readFile(new URL(`rootfs${path}`, LOCAL_SANDBOX), "utf8")).toBe(`${text}\n`);
    }
  });
});
