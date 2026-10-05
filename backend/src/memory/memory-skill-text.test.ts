import { describe, expect, test } from "bun:test";
import { MEMORY_TURN_GUIDANCE, MEMORY_TURN_GUIDANCE_NO_TOOLS, MEMORY_UNAVAILABLE_NOTE } from "./memory-skill-text";

describe("memory turn guidance", () => {
  test("names every memory tool and forbids the sandbox file as a memory store", () => {
    for (const tool of ["memory_search", "memory_read", "memory_remember", "memory_correct", "memory_forget"]) {
      expect(MEMORY_TURN_GUIDANCE).toContain(tool);
    }
    expect(MEMORY_TURN_GUIDANCE).toContain("/root/.skynet/memory.md");
    expect(MEMORY_TURN_GUIDANCE).toContain("saves nothing");
    expect(MEMORY_TURN_GUIDANCE).toContain("unless the tool call succeeded");
  });

  test("the no-tools text claims no save and forbids the file too", () => {
    expect(MEMORY_TURN_GUIDANCE_NO_TOOLS).not.toContain("memory_remember");
    expect(MEMORY_TURN_GUIDANCE_NO_TOOLS).toContain("/root/.skynet/memory.md");
    expect(MEMORY_TURN_GUIDANCE_NO_TOOLS).toContain("captured automatically");
  });

  test("no em dashes in agent-facing text", () => {
    for (const text of [MEMORY_TURN_GUIDANCE, MEMORY_TURN_GUIDANCE_NO_TOOLS, MEMORY_UNAVAILABLE_NOTE]) {
      expect(text).not.toContain("\u2014");
    }
  });
});
