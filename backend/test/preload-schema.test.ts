import { expect, test } from "bun:test";
import { client } from "../src/db/client";

// Deliberately no ./helpers import: a database-backed file must be safe to run
// alone (or first in CI's file order) on a freshly created, empty database,
// because test/preload.ts applies the migrations before the first test file.
test("the schema is in place before the first test file without booting the app", async () => {
  const [row] = await client`select to_regclass('public.runs')::text as runs`;
  expect(row?.runs).toBe("runs");
});
