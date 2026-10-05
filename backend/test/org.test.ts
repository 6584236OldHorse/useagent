import { describe, expect, test } from "bun:test";
import { createOrgSession, json } from "./helpers";

describe("org scoping", () => {
  test("dev fallback (no session) plants no demo skills at boot", async () => {
    const { status, body } = await json<{ skills: { name: string }[] }>("/api/skills");
    expect(status).toBe(200);
    expect(Array.isArray(body.skills)).toBe(true);
    const names = body.skills.map((skill) => skill.name);
    for (const demo of [
      "Ship a new page",
      "Fix flaky test",
      "Design review pass",
      "Port dashboard widget",
      "Write release notes",
      "Refactor to tokens",
      "Add API route",
    ]) {
      expect(names).not.toContain(demo);
    }
  });

  test("skills are org-scoped: an org sees only what it creates", async () => {
    const { cookies } = await createOrgSession("acme");
    const before = await json<{ skills: unknown[] }>("/api/skills", { cookies });
    expect(before.status).toBe(200);
    expect(before.body.skills).toHaveLength(0);

    const created = await json<{ id: string }>("/api/skills", {
      method: "POST",
      cookies,
      body: {
        name: "Acme-only playbook",
        description: "Fixture skill scoped to this org.",
        tags: ["review"],
        sections: { overview: ["step"], procedure: ["step"], verify: ["step"] },
      },
    });
    expect(created.status).toBe(201);
    expect((await json<{ skills: unknown[] }>("/api/skills", { cookies })).body.skills).toHaveLength(
      1,
    );

    const other = await createOrgSession("globex");
    const otherSkills = await json<{ skills: unknown[] }>("/api/skills", {
      cookies: other.cookies,
    });
    expect(otherSkills.status).toBe(200);
    expect(otherSkills.body.skills).toHaveLength(0);
  });
});
