import { describe, expect, test } from "bun:test";
import { runCli } from "../src/backends/cli-backend";

describe("command line tools", () => {
  test("a tool that is not installed answers like a failed command", async () => {
    const result = await runCli(["useagent-no-such-tool-for-this-test", "info"]);
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toMatch(/not found|ENOENT|no such/i);
    expect(result.timedOut).toBe(false);
  });
});
