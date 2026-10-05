import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { json } from "./helpers";

// Where a run executes reaches the client: the provider the run was bound to
// rides every run read as `sandbox_provider`, so the Details rail and the
// composer's status tab can name it instead of "Unknown runtime". Runs use the
// default `mock` engine; the binding is written straight onto the row here
// because no sandbox is provisioned in this suite.

type Located = { sandbox_provider: string | null };

describe("sandbox provider on the run wire", () => {
  test("a run reports the provider it was bound to on the single read and on the thread read", async () => {
    const created = await json<{ id: string }>("/api/runs", {
      method: "POST",
      body: { prompt: "where do I run" },
    });
    expect(created.status).toBe(201);
    const fresh = await json<Located>(`/api/runs/${created.body.id}`);
    expect(fresh.body).toHaveProperty("sandbox_provider");

    await db.execute(sql`update runs set sandbox_provider = 'daytona' where id = ${created.body.id}`);
    const bound = await json<Located>(`/api/runs/${created.body.id}`);
    expect(bound.body.sandbox_provider).toBe("daytona");
    const { body: threaded } = await json<{ thread: Located[] }>(`/api/runs/${created.body.id}?thread=1`);
    expect(threaded.thread.map((run) => run.sandbox_provider)).toEqual(["daytona"]);
  });
});
