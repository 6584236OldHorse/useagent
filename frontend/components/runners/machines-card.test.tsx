import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MachinesCard } from "./machines-card";
import { RunnerSettingsProvider } from "./runner-settings-context";

test("a normal browser renders machine inventory without a desktop connect action", () => {
  const html = renderToStaticMarkup(
    <RunnerSettingsProvider>
      <MachinesCard />
    </RunnerSettingsProvider>,
  );
  expect(html).toContain("Loading machines...");
  expect(html).toContain("Refresh");
  expect(html).not.toContain("Connect this Mac");
  expect(html).not.toContain("—");
});
