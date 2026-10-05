import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseSandboxPreference, SandboxProviderRow, SandboxProviderSelect } from "./sandbox-provider-row";

test("renders the row with its loading label before the preference arrives, without em dashes", () => {
  const html = renderToStaticMarkup(createElement(SandboxProviderRow));
  expect(html).toContain("Preferred sandbox provider");
  expect(html).toContain("Loading...");
  expect(html).not.toContain("—");
});

test("parses the backend shape, dropping malformed providers", () => {
  expect(
    parseSandboxPreference({
      provider: "cube",
      defaultProvider: "daytona",
      enabled: [{ kind: "daytona", label: "Daytona" }, { kind: "cube", label: "Cube" }, { kind: 3 }],
    }),
  ).toEqual({ provider: "cube", defaultProvider: "daytona", enabled: [{ kind: "daytona", label: "Daytona" }, { kind: "cube", label: "Cube" }] });
  expect(parseSandboxPreference({ provider: null, enabled: [] })).toBeNull();
});

test("the select marks the deployment default and lists every enabled provider", () => {
  const html = renderToStaticMarkup(
    createElement(SandboxProviderSelect, {
      preference: { provider: "cube", defaultProvider: "daytona", enabled: [{ kind: "daytona", label: "Daytona" }, { kind: "cube", label: "Cube" }] },
      disabled: false,
      onChoose: () => {},
    }),
  );
  expect(html).toContain("Daytona (default)");
  expect(html).toContain("Cube");
});
