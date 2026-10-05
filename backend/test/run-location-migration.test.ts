import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";

// The boot migrator applies only journal entries stamped strictly above the last
// one applied, so a database deployed at main's tail when this branch was cut
// (0103_runs_permission_mode) must still pick up the run location column: the
// entry sits after that tail in the journal with a higher stamp, and a row from
// before the choice existed reads as no choice.
test("a database deployed at main's journal tail upgrades into the run location column", async () => {
  const migrationsFolder = `${import.meta.dir}/../drizzle`;
  const partialFolder = await mkdtemp(join(tmpdir(), "useagent-0103-"));
  const databaseName = `useagent_rl_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const admin = postgres(ADMIN_URL, { max: 1 });
  const databaseUrl = new URL(ADMIN_URL);
  databaseUrl.pathname = `/${databaseName}`;
  let client: ReturnType<typeof postgres> | null = null;

  try {
    const journal = JSON.parse(
      await Bun.file(`${migrationsFolder}/meta/_journal.json`).text(),
    ) as {
      entries: Array<{ tag: string; when: number; [key: string]: unknown }>;
      [key: string]: unknown;
    };
    const cutoff = journal.entries.findIndex((entry) => entry.tag === "0103_runs_permission_mode");
    const ours = journal.entries.findIndex((entry) => entry.tag === "0106_runs_run_location");
    expect(cutoff).toBeGreaterThanOrEqual(0);
    expect(ours).toBeGreaterThan(cutoff);
    expect(journal.entries[ours]!.when).toBeGreaterThan(journal.entries[cutoff]!.when);
    // The stamp is the journal's tail: nothing after it may carry an older one.
    expect(journal.entries[ours]!.when).toBe(Math.max(...journal.entries.map((entry) => entry.when)));
    const mainEntries = journal.entries.slice(0, cutoff + 1);
    await mkdir(join(partialFolder, "meta"), { recursive: true });
    await Bun.write(
      join(partialFolder, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: mainEntries }, null, 2),
    );
    for (const entry of mainEntries) {
      await Bun.write(
        join(partialFolder, `${entry.tag}.sql`),
        Bun.file(`${migrationsFolder}/${entry.tag}.sql`),
      );
    }

    await admin.unsafe(`create database "${databaseName}"`);
    client = postgres(databaseUrl.toString(), { max: 1 });
    const upgradeDb = drizzle(client);
    await migrate(upgradeDb, { migrationsFolder: partialFolder });
    await client.unsafe(`
      insert into runs (id, org_id, prompt, model, engine, status, thread_id)
      values ('legacy-run', 'org-legacy', 'legacy', 'openai/gpt-5.6-luna', 'opencode', 'completed', 'legacy-run');
    `);

    await migrate(upgradeDb, { migrationsFolder });

    const [run] = await client.unsafe<{ run_location: string | null }[]>(
      `select run_location from runs where id = 'legacy-run'`,
    );
    expect(run).toEqual({ run_location: null });
  } finally {
    if (client) await client.end();
    await admin`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = ${databaseName} and pid <> pg_backend_pid()
    `.catch(() => {});
    await admin.unsafe(`drop database if exists "${databaseName}"`).catch(() => {});
    await admin.end();
    await rm(partialFolder, { recursive: true, force: true });
  }
}, 60_000); // replays every migration on a fresh database; CI runners need more than the 5 s default
