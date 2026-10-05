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
    // Nothing after it may carry an older stamp, or the boot migrator would skip it.
    for (const later of journal.entries.slice(ours + 1)) expect(later.when).toBeGreaterThan(journal.entries[ours]!.when);
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
    // A cloud thread; a thread that ran on a machine under the old rule (its root
    // holds the local sandbox, its reply never recorded one); and a thread that
    // ran on a machine, released that sandbox and then replied on the cloud.
    await client.unsafe(`
      insert into runs (id, org_id, prompt, model, engine, status, thread_id, thread_seq, sandbox_id, sandbox_provider)
      values ('legacy-run', 'org-legacy', 'legacy', 'openai/gpt-5.6-luna', 'opencode', 'completed', 'legacy-run', 1, 'sb_cloud', 'daytona'),
             ('legacy-local', 'org-legacy', 'legacy', 'openai/gpt-5.6-luna', 'opencode', 'completed', 'legacy-local', 1, 'local:rn_a:c1', 'local'),
             ('legacy-local-reply', 'org-legacy', 'legacy', 'openai/gpt-5.6-luna', 'opencode', 'completed', 'legacy-local', 2, null, null),
             ('legacy-moved', 'org-legacy', 'legacy', 'openai/gpt-5.6-luna', 'opencode', 'completed', 'legacy-moved', 1, null, 'local'),
             ('legacy-moved-reply', 'org-legacy', 'legacy', 'openai/gpt-5.6-luna', 'opencode', 'completed', 'legacy-moved', 2, 'sb_cloud_2', 'daytona');
    `);

    await migrate(upgradeDb, { migrationsFolder });

    const rows = await client.unsafe<{ id: string; run_location: string | null }[]>(
      `select id, run_location from runs where org_id = 'org-legacy' order by id`,
    );
    expect(rows).toEqual([
      { id: "legacy-local", run_location: "local" },
      { id: "legacy-local-reply", run_location: "local" },
      { id: "legacy-moved", run_location: null },
      { id: "legacy-moved-reply", run_location: null },
      { id: "legacy-run", run_location: null },
    ]);
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
