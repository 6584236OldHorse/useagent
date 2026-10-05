import { describe, expect, test } from "bun:test";
import { slackThreadControl } from "./asides";

describe("slack thread controls", () => {
  test("an aside is any message that opens with (aside) or !aside", () => {
    for (const text of ["(aside) this run looks slow", "(ASIDE) ok", "  !aside not for you", "!aside, check line 3", "!Aside"]) {
      expect(slackThreadControl(text)).toBe("aside");
    }
  });

  test("mute and unmute stand alone, any case, trailing punctuation allowed", () => {
    expect(slackThreadControl("mute")).toBe("mute");
    expect(slackThreadControl("Mute.")).toBe("mute");
    expect(slackThreadControl("  UNMUTE!  ")).toBe("unmute");
    expect(slackThreadControl("unmute")).toBe("unmute");
  });

  test("near-misses stay ordinary prompts", () => {
    for (const text of [
      "mute the alerts",
      "please mute",
      "asides are fine",
      "!asides",
      "aside from that, deploy",
      "(aside",
      "unmuted?",
      "",
    ]) {
      expect(slackThreadControl(text)).toBeNull();
    }
  });
});
