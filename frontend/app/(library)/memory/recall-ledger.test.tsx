import { expect, test } from "bun:test";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import type { RecallLedgerRow } from "./memory-data";
import { RecallLedger } from "./recall-ledger";

const router = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch() {},
} as unknown as AppRouterInstance;

const row: RecallLedgerRow = {
  runId: "run-1",
  threadId: "thread-1",
  memoryScope: "org",
  query: "deploy region",
  itemCount: 0,
  items: [],
  latencyMs: 5000,
  truncated: false,
  degraded: false,
  createdAt: new Date().toISOString(),
};

function render(rows: RecallLedgerRow[]) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <RecallLedger recalls={rows} error={false} onRefetch={() => {}} />
    </AppRouterContext.Provider>,
  );
}

test("a degraded recall says memory unavailable instead of a false 0 items", () => {
  expect(render([row])).toContain("0 items");
  const html = render([{ ...row, degraded: true }]);
  expect(html).toContain("memory unavailable");
  expect(html).not.toContain("0 items");
});
