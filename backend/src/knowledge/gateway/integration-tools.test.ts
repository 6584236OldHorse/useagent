import { afterEach, describe, expect, test } from "bun:test";
import type { IntegrationActionCatalogEntry } from "@useagent/agent-client/integrations";
import {
  executeIntegrationTool,
  setIntegrationToolServiceForTest,
} from "./integration-tools";
import type { ToolTokenClaims } from "./token";

const CLAIMS = {
  orgId: "org-a",
  userId: "user-a",
  threadId: "thread-a",
  runId: "run-a",
  scope: "run",
  exp: Date.now() + 60_000,
} as const satisfies ToolTokenClaims;

function entry(overrides: Partial<IntegrationActionCatalogEntry> = {}): IntegrationActionCatalogEntry {
  return {
    catalogVersion: 1,
    runtimeVersion: "1.4.0",
    runtimeCommit: "96fb6afe8c244c7d6f3a8351df06d7b04137f6a6",
    provider: "linear",
    actionId: "linear.get_issue",
    publicName: "get_issue",
    description: "Read one Linear issue.",
    inputSchema: {
      type: "object",
      properties: { issueId: { type: "string" } },
      required: ["issueId"],
      additionalProperties: false,
    },
    effect: "read",
    approval: "none",
    timeoutMs: 8_000,
    maxResultBytes: 8_000,
    idempotent: true,
    ...overrides,
  };
}

afterEach(() => setIntegrationToolServiceForTest(null));

describe("integration gateway tools", () => {
  test("search returns only tenant-visible connected action metadata", async () => {
    const calls: unknown[] = [];
    setIntegrationToolServiceForTest({
      async list(scope) {
        calls.push(scope);
        return [
          { connectionId: "connection-a", entry: entry() },
          {
            connectionId: "connection-b",
            entry: entry({
              provider: "gmail",
              actionId: "gmail.send_email",
              publicName: "send_email",
              description: "Send a Gmail message.",
            }),
          },
        ];
      },
      async execute() {
        throw new Error("not used");
      },
    });

    const result = await executeIntegrationTool(CLAIMS, "integration_actions_search", {
      query: "linear issue",
    });

    expect(calls).toEqual([{ orgId: "org-a", userId: "user-a" }]);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.actions).toEqual([
      expect.objectContaining({
        connectionId: "connection-a",
        provider: "linear",
        actionId: "linear.get_issue",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("runtimeBindingId");
    expect(JSON.stringify(result)).not.toContain("externalConnectionId");
  });

  test("execute rechecks the exact visible connection and action", async () => {
    const calls: unknown[] = [];
    setIntegrationToolServiceForTest({
      async list() {
        return [{ connectionId: "connection-a", entry: entry() }];
      },
      async execute(input) {
        calls.push(input);
        return { issue: { id: "LIN-1" } };
      },
    });

    const result = await executeIntegrationTool(CLAIMS, "integration_action_execute", {
      connectionId: "connection-a",
      actionId: "linear.get_issue",
      input: { issueId: "LIN-1" },
      idempotencyKey: "read-LIN-1",
    });

    expect(result.isError).not.toBe(true);
    expect(calls).toEqual([
      {
        orgId: "org-a",
        userId: "user-a",
        connectionId: "connection-a",
        actionId: "linear.get_issue",
        input: { issueId: "LIN-1" },
        idempotencyKey: "read-LIN-1",
        approvalGranted: true,
      },
    ]);
  });

  test("execute refuses an action that disappeared before the call", async () => {
    let executeCalls = 0;
    setIntegrationToolServiceForTest({
      async list() {
        return [];
      },
      async execute() {
        executeCalls += 1;
        return {};
      },
    });

    const result = await executeIntegrationTool(CLAIMS, "integration_action_execute", {
      connectionId: "connection-a",
      actionId: "linear.get_issue",
      input: { issueId: "LIN-1" },
    });

    expect(executeCalls).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not available");
  });

  test("execute does not return an oversized connector response", async () => {
    setIntegrationToolServiceForTest({
      async list() {
        return [{
          connectionId: "connection-a",
          entry: entry({ maxResultBytes: 16 }),
        }];
      },
      async execute() {
        return { content: "x".repeat(100) };
      },
    });

    const result = await executeIntegrationTool(CLAIMS, "integration_action_execute", {
      connectionId: "connection-a",
      actionId: "linear.get_issue",
      input: { issueId: "LIN-1" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("exceeded 16 bytes");
    expect(JSON.stringify(result)).not.toContain("xxxxxxxx");
  });
});

describe("integration action search ranking", () => {
  const gmail = (actionId: string, publicName: string, description: string) => ({
    connectionId: "connection-gmail",
    entry: entry({ provider: "gmail", actionId, publicName, description }),
  });
  const catalogue = [
    { connectionId: "connection-a", entry: entry() },
    gmail("gmail.send_email", "send_email", "Send a Gmail message."),
    gmail("gmail.list_messages", "list_messages", "List messages in the mailbox, newest first."),
    gmail("gmail.get_message", "get_message", "Read one message by id."),
  ];
  const fake = { async list() { return catalogue; }, async execute(): Promise<never> { throw new Error("not used"); } };

  afterEach(() => setIntegrationToolServiceForTest(null));

  test("a sentence finds the actions that mention any of its words, best first", async () => {
    setIntegrationToolServiceForTest(fake);
    const result = await executeIntegrationTool(CLAIMS, "integration_actions_search", {
      provider: "gmail",
      query: "list or read the five most recent emails",
    });
    const ids = (result.structuredContent?.actions as Array<{ actionId: string }>).map((a) => a.actionId);
    expect(ids.toSorted()).toEqual(["gmail.get_message", "gmail.list_messages", "gmail.send_email"]);
    expect(ids).not.toContain("linear.get_issue");
    expect(JSON.stringify(result.content)).toContain("Found");
  });

  test("words that match nothing still list the named provider's actions", async () => {
    setIntegrationToolServiceForTest(fake);
    const result = await executeIntegrationTool(CLAIMS, "integration_actions_search", { provider: "gmail", query: "zzzz qqqq" });
    expect((result.structuredContent?.actions as unknown[]).length).toBe(3);
    expect(JSON.stringify(result.content)).toContain("listing 3 available gmail actions");
  });

  test("a provider with no connection says so and names what is connected", async () => {
    setIntegrationToolServiceForTest(fake);
    const result = await executeIntegrationTool(CLAIMS, "integration_actions_search", { provider: "slack", query: "post a message" });
    expect(result.structuredContent?.actions).toEqual([]);
    expect(JSON.stringify(result.content)).toContain("No slack integration is connected for this user. Connected: gmail, linear.");
  });
});
