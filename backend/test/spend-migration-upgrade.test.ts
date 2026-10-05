import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";

// The re-stamp's proof. The boot migrator applies only the journal entries
// whose `when` is greater than the last one a database has applied, so a
// database that already ran everything main has (its journal ends at main's
// tail) picks the spend ledger up only if the ledger's entry sorts strictly
// above that tail. A clean-database run proves nothing about this path: here
// the journal before the ledger is applied first, as merged, and the ledger's
// entry (with every migration stamped after it) on the next boot.
test("a database at main's journal tail upgrades into the spend ledger on the next boot", async () => {
  const migrationsFolder = `${import.meta.dir}/../drizzle`;
  const mainFolder = await mkdtemp(join(tmpdir(), "useagent-main-tail-"));
  const databaseName = `useagent_spend_up_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const admin = postgres(ADMIN_URL, { max: 1 });
  const databaseUrl = new URL(ADMIN_URL);
  databaseUrl.pathname = `/${databaseName}`;
  let client: ReturnType<typeof postgres> | null = null;
  try {
    const journal = JSON.parse(await Bun.file(`${migrationsFolder}/meta/_journal.json`).text()) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
      [key: string]: unknown;
    };
    const ledgerIndex = journal.entries.findIndex((entry) => entry.tag === "0104_spend_ledger");
    expect(ledgerIndex).toBeGreaterThan(0);
    const ledger = journal.entries[ledgerIndex]!;
    for (let i = 1; i < journal.entries.length; i += 1) {
      expect(journal.entries[i]!.when).toBeGreaterThan(journal.entries[i - 1]!.when);
    }
    // Main's journal as merged: every entry before the ledger's.
    const mainEntries = journal.entries.slice(0, ledgerIndex);
    await mkdir(join(mainFolder, "meta"), { recursive: true });
    await Bun.write(join(mainFolder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: mainEntries }, null, 2));
    for (const entry of mainEntries) {
      await Bun.write(join(mainFolder, `${entry.tag}.sql`), Bun.file(`${migrationsFolder}/${entry.tag}.sql`));
    }

    await admin.unsafe(`create database "${databaseName}"`);
    client = postgres(databaseUrl.toString(), { max: 1 });
    const upgradeDb = drizzle(client);
    const ledgerTables = async () =>
      (await client!.unsafe<{ table_name: string }[]>(
        "select table_name from information_schema.tables where table_schema = 'public' and table_name in ('spend_accounts', 'spend_entries') order by 1",
      )).map((row) => row.table_name);
    const applied = async () =>
      (await client!.unsafe<{ created_at: string }[]>("select created_at from drizzle.__drizzle_migrations order by created_at"))
        .map((row) => Number(row.created_at));

    // A deployment at main's tail.
    await migrate(upgradeDb, { migrationsFolder: mainFolder });
    expect(await ledgerTables()).toEqual([]);
    const atMain = await applied();
    expect(atMain.at(-1)).toBe(mainEntries.at(-1)!.when);

    // Its next boot with the branch: the ledger is applied above the tail, and
    // every migration stamped after it follows in order.
    await migrate(upgradeDb, { migrationsFolder });
    expect(await ledgerTables()).toEqual(["spend_accounts", "spend_entries"]);
    const upgraded = await applied();
    expect(upgraded).toEqual([...atMain, ...journal.entries.slice(ledgerIndex).map((entry) => entry.when)]);
    expect(upgraded).toContain(ledger.when);
    for (let i = 1; i < upgraded.length; i += 1) expect(upgraded[i]!).toBeGreaterThan(upgraded[i - 1]!);
  } finally {
    await client?.end();
    await admin.unsafe(`drop database if exists "${databaseName}"`).catch(() => {});
    await admin.end();
    await rm(mainFolder, { recursive: true, force: true });
  }
}, 60_000);
