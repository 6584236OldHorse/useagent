import { afterAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { db } from "../src/db/client";
import { spendAccounts } from "../src/db/schema";
import { applyGatewayGrants, GATEWAY_DATABASE_ROLE } from "../src/db/gateway-grants";
import { assertSpendAllowance, SpendAllowanceExceededError } from "../src/runs/spend";
import { testDatabaseUrl } from "./test-database";
import "./helpers"; // boots src/index -> migrate

// The spend admission check under the RESTRICTED gateway role, against the
// real grants manifest on this throwaway database: the role exists (created
// here when the server has none), the manifest is applied, and the check runs
// through a connection authenticated as that role. Today a restricted gateway
// bridges every acceptance to the backend, so this proves the grant rather
// than a live path; it must keep holding if an in-process acceptance appears.

const adminUrl = new URL(testDatabaseUrl());
const gatewayUrl = new URL(testDatabaseUrl());
gatewayUrl.username = GATEWAY_DATABASE_ROLE;
gatewayUrl.password = "";
const admin = postgres(adminUrl.toString(), { max: 1 });
const asGateway = postgres(gatewayUrl.toString(), { max: 1 });

afterAll(async () => {
  await admin.end({ timeout: 2 }).catch(() => undefined);
  await asGateway.end({ timeout: 2 }).catch(() => undefined);
});

test("the admission check reads spend_accounts under the restricted gateway role", async () => {
  await admin.unsafe(
    `do $$ begin if not exists (select 1 from pg_roles where rolname = '${GATEWAY_DATABASE_ROLE}') then create role ${GATEWAY_DATABASE_ROLE} login; end if; end $$`,
  );
  await applyGatewayGrants(admin);
  const orgId = `gateway-spend-${crypto.randomUUID()}`;
  const userId = `user-${crypto.randomUUID()}`;
  await db.insert(spendAccounts).values({ orgId, userId, spentUsd: 100 });

  const [who] = await asGateway`select current_user`;
  expect(who!.current_user).toBe(GATEWAY_DATABASE_ROLE);
  const gatewayDb = drizzle(asGateway);
  // A member under the cap passes; a member at the cap is refused; neither
  // read is denied by the role's grants.
  await assertSpendAllowance(orgId, `user-${crypto.randomUUID()}`, gatewayDb);
  let refusal: unknown = null;
  try {
    await assertSpendAllowance(orgId, userId, gatewayDb);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(SpendAllowanceExceededError);
  // The ledger stays read-only for the role: only the backend's finalization writes it.
  let denied: unknown = null;
  try {
    await asGateway.unsafe(`insert into spend_accounts (org_id, user_id) values ('${orgId}', 'user-${crypto.randomUUID()}')`);
  } catch (error) {
    denied = error;
  }
  expect(String((denied as Error | null)?.message ?? "")).toMatch(/permission denied/);
}, 20_000);
