import { describe, expect, test } from "bun:test";
import { isPublicApiPath } from "../src/middleware/org";
import { freeModelLane } from "../src/runs/free-model-lane";
import { createOrgSession, json } from "./helpers";

// POST /api/config/models/refresh - the picker's manual Free-lane refresh runs a
// qualifier tick (catalog discovery now, probe runs in the background). The unit
// suite runs with the qualifier's kill switch set (test/preload.ts), so the
// route reports that honestly with the current manifest; the tick itself is
// covered in src/runs/free-model-qualifier-worker.test.ts.

describe("manual free-model refresh endpoint", () => {
  test("is org-scoped by the universal adapter, never public", () => {
    expect(isPublicApiPath("/api/config/models/refresh")).toBe(false);
  });

  test("reports the kill switch with the current manifest instead of pretending", async () => {
    const org = await createOrgSession("free-refresh-off");
    const response = await json<{
      error: string;
      free: string[];
      models: Record<string, string[]>;
      configuredModels: Record<string, string[]>;
    }>("/api/config/models/refresh", { method: "POST", cookies: org.cookies });
    expect(response.status).toBe(503);
    expect(response.body.error).toBe("qualifier_off");
    expect(response.body.free).toEqual([...freeModelLane()]);
    for (const model of freeModelLane()) {
      expect(response.body.models.opencode).toContain(model);
    }
  });
});
