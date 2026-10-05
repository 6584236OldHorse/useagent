import { describe, expect, test } from "bun:test";
import {
  ensureCanonicalExecutionTranscriptIndexForBoot,
  classifyCanonicalExecutionIndex,
  type CanonicalExecutionIndexCatalogRow,
} from "./canonical-execution-transcript";

function catalogRow(
  overrides: Partial<CanonicalExecutionIndexCatalogRow> = {},
): CanonicalExecutionIndexCatalogRow {
  return {
    schema_name: "public",
    table_name: "canonical_events",
    index_name: "idx_canonical_events_execution_delivery_v1",
    access_method: "btree",
    predicate: null,
    total_attributes: 4,
    key_attributes: 4,
    is_unique: false,
    is_valid: true,
    is_ready: true,
    is_live: true,
    key_expressions: [
      "run_id",
      "(identity ->> 'provider'::text)",
      "(identity ->> 'nativeSessionId'::text)",
      "delivery_seq",
    ],
    ...overrides,
  };
}

describe("canonical execution transcript online index catalog", () => {
  test("classifies absent and the exact ready definition", () => {
    expect(classifyCanonicalExecutionIndex([])).toEqual({ kind: "absent" });
    expect(classifyCanonicalExecutionIndex([catalogRow()])).toEqual({ kind: "exact-valid" });
  });

  test("distinguishes invalid residue from valid definition mismatch", () => {
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ is_valid: false, is_ready: false }),
    ])).toMatchObject({ kind: "invalid-residue" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ key_expressions: ["run_id", "delivery_seq"] }),
    ])).toMatchObject({ kind: "valid-mismatch" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ table_name: "provider_events" }),
    ])).toMatchObject({ kind: "valid-mismatch" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ table_name: "provider_events", is_valid: false }),
    ])).toMatchObject({ kind: "valid-mismatch" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ predicate: "false" }),
    ])).toMatchObject({ kind: "valid-mismatch" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ total_attributes: 5 }),
    ])).toMatchObject({ kind: "valid-mismatch" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ access_method: "hash" }),
    ])).toMatchObject({ kind: "valid-mismatch" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ is_unique: true }),
    ])).toMatchObject({ kind: "valid-mismatch" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ predicate: "false", is_valid: false, is_ready: false }),
    ])).toMatchObject({ kind: "valid-mismatch" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ total_attributes: 5, is_valid: false, is_live: false }),
    ])).toMatchObject({ kind: "valid-mismatch" });
  });
});

describe("canonical execution transcript boot guard", () => {
  test("does nothing when the execution graph is switched off", async () => {
    let calls = 0;
    await ensureCanonicalExecutionTranscriptIndexForBoot({ EXECUTION_GRAPH_ROLLOUT: "off" }, async () => { calls += 1; });
    expect(calls).toBe(0);
  });

  test("an enabled process ensures the index and fails boot when it cannot", async () => {
    let calls = 0;
    await ensureCanonicalExecutionTranscriptIndexForBoot({}, async () => { calls += 1; });
    await ensureCanonicalExecutionTranscriptIndexForBoot({ EXECUTION_GRAPH_ROLLOUT: " READ " }, async () => { calls += 1; });
    expect(calls).toBe(2);
    await expect(ensureCanonicalExecutionTranscriptIndexForBoot(
      { EXECUTION_GRAPH_ROLLOUT: "read" },
      async () => { throw new Error("index apply failed"); },
    )).rejects.toThrow("index apply failed");
  });
});
