import { describe, expect, test } from "bun:test";
import {
  assertThreadRelationshipConfig,
  productChildThreadsEnabled,
  threadRelationshipsEnabled,
} from "./thread-relationship-switch";

describe("thread relationship switches", () => {
  test("relationships and product child threads are on unless switched off; the historical staged values mean on", () => {
    expect(threadRelationshipsEnabled({})).toBe(true);
    expect(threadRelationshipsEnabled({ THREAD_RELATIONSHIPS_WRITE: "on" })).toBe(true);
    expect(threadRelationshipsEnabled({ THREAD_RELATIONSHIPS_WRITE: "shadow" })).toBe(true);
    expect(threadRelationshipsEnabled({ THREAD_RELATIONSHIPS_WRITE: " OFF " })).toBe(false);
    expect(productChildThreadsEnabled({})).toBe(true);
    expect(productChildThreadsEnabled({ PRODUCT_CHILD_THREADS: "on" })).toBe(true);
    expect(productChildThreadsEnabled({ PRODUCT_CHILD_THREADS: "off" })).toBe(false);
  });

  test("stale staged lines are inert: read, canary and composer settings no longer gate anything", () => {
    const env = {
      THREAD_RELATIONSHIPS_READ: "off",
      PRODUCT_CHILD_CANARY_ORG_IDS: "org-canary",
      PRODUCT_CHILD_COMPOSER: "off",
    };
    expect(threadRelationshipsEnabled(env)).toBe(true);
    expect(productChildThreadsEnabled(env)).toBe(true);
  });

  test("boot refuses product child threads while relationships are switched off", () => {
    expect(() => assertThreadRelationshipConfig({ THREAD_RELATIONSHIPS_WRITE: "off" })).toThrow(/PRODUCT_CHILD_THREADS=off/);
    expect(() => assertThreadRelationshipConfig({ THREAD_RELATIONSHIPS_WRITE: "off", PRODUCT_CHILD_THREADS: "off" })).not.toThrow();
    expect(() => assertThreadRelationshipConfig({})).not.toThrow();
  });
});
