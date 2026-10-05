import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as bindings from "../sandboxes/binding";
import { convertOfficeToPdf, setOfficePreviewConverterForTest } from "./office-preview";

afterEach(() => {
  setOfficePreviewConverterForTest(null);
});

describe("Office preview conversion isolation", () => {
  test("uses accepted run authority instead of resolving a current binding", async () => {
    const sandbox = {
      id: "sandbox-a",
      process: { executeCommand: async () => ({ exitCode: 1, result: "" }) },
    };
    const run = {
      orgId: "org-a",
      threadId: "thread-a",
      sandboxId: "sandbox-a",
      expectedSandbox: {
        version: 1 as const,
        sandboxId: "sandbox-a",
        provider: "daytona" as const,
        credential: "env" as const,
        ownerOrgId: "org-a",
        ownerUserId: null,
        credentialGeneration: "a".repeat(64),
      },
    };
    const strictResolver = spyOn(bindings, "resolveRunSandbox").mockResolvedValue(sandbox as never);
    const legacyResolver = spyOn(bindings, "resolveSandboxBindingForSandbox");
    try {
      expect(await convertOfficeToPdf({
        sandboxId: "sandbox-a",
        run,
        sourceName: "report.docx",
        sourceBytes: new TextEncoder().encode("source"),
        timeoutSeconds: 30,
        maxBytes: 1_024,
      })).toBeNull();
      expect(strictResolver).toHaveBeenCalledWith(run);
      expect(legacyResolver).not.toHaveBeenCalled();
    } finally {
      strictResolver.mockRestore();
      legacyResolver.mockRestore();
    }
  });

  test("concurrent conversions upload and download distinct byte snapshots", async () => {
    const uploaded = new Map<string, Uint8Array>();
    const outputs = new Map<string, Uint8Array>();
    const conversionCommands: string[] = [];
    const cleaned: string[] = [];
    const sandbox = {
      process: {
        executeCommand: async (command: string) => {
          const mkdir = /^mkdir -m 700 -- '([^']+)'$/.exec(command);
          if (mkdir) return { exitCode: 0, result: "" };
          const cleanup = /^rm -rf -- '([^']+)'$/.exec(command);
          if (cleanup?.[1]) {
            cleaned.push(cleanup[1]);
            return { exitCode: 0, result: "" };
          }
          conversionCommands.push(command);
          const inputPath = /'([^']+\/input\.docx)'$/.exec(command)?.[1];
          const outdir = /--outdir '([^']+)'/.exec(command)?.[1];
          if (!inputPath || !outdir) return { exitCode: 1, result: "" };
          outputs.set(`${outdir}/input.pdf`, new Uint8Array([
            ...new TextEncoder().encode("%PDF-"),
            ...(uploaded.get(inputPath) ?? []),
          ]));
          return { exitCode: 0, result: "" };
        },
      },
      fs: {
        uploadFile: async (bytes: Uint8Array, path: string) => {
          uploaded.set(path, new Uint8Array(bytes));
        },
        getFileDetails: async (path: string) => ({ size: outputs.get(path)?.byteLength ?? 0 }),
        downloadFile: async (path: string) => outputs.get(path) ?? new Uint8Array(),
      },
    };
    const resolver = spyOn(bindings, "resolveSandboxBindingForSandbox").mockResolvedValue({
      provider: { get: async () => sandbox },
    } as never);
    const firstBytes = new TextEncoder().encode("first-source");
    const secondBytes = new TextEncoder().encode("second-source");
    try {
      const [first, second] = await Promise.all([
        convertOfficeToPdf({
          sandboxId: "sandbox-a",
          sourceName: "report.docx",
          sourceBytes: firstBytes,
          timeoutSeconds: 30,
          maxBytes: 1_024,
        }),
        convertOfficeToPdf({
          sandboxId: "sandbox-a",
          sourceName: "report.docx",
          sourceBytes: secondBytes,
          timeoutSeconds: 30,
          maxBytes: 1_024,
        }),
      ]);

      expect(first).toEqual(new Uint8Array([...new TextEncoder().encode("%PDF-"), ...firstBytes]));
      expect(second).toEqual(new Uint8Array([...new TextEncoder().encode("%PDF-"), ...secondBytes]));
      const inputPaths = [...uploaded.keys()];
      expect(inputPaths).toHaveLength(2);
      expect(new Set(inputPaths.map((path) => path.replace(/\/input\.docx$/, ""))).size).toBe(2);
      expect(conversionCommands).toHaveLength(2);
      for (const command of conversionCommands) {
        const root = /--outdir '([^']+)'/.exec(command)?.[1];
        expect(root).toBeTruthy();
        expect(command).toContain(`'-env:UserInstallation=file://${root}/profile'`);
        expect(command).toEndWith(`'${root}/input.docx'`);
      }
      expect(cleaned.toSorted()).toEqual(inputPaths.map((path) => path.replace(/\/input\.docx$/, "")).toSorted());
    } finally {
      resolver.mockRestore();
    }
  });

  test("cleans only an acquired private directory on failure", async () => {
    const cleaned: string[] = [];
    let mkdirCalls = 0;
    let conversionCalls = 0;
    const sandbox = {
      process: {
        executeCommand: async (command: string) => {
          const mkdir = /^mkdir -m 700 -- '([^']+)'$/.exec(command);
          if (mkdir) {
            mkdirCalls += 1;
            return { exitCode: mkdirCalls === 1 ? 1 : 0, result: "" };
          }
          const cleanup = /^rm -rf -- '([^']+)'$/.exec(command);
          if (cleanup?.[1]) cleaned.push(cleanup[1]);
          if (command.startsWith("soffice ")) {
            conversionCalls += 1;
            return { exitCode: conversionCalls === 1 ? 1 : 0, result: "" };
          }
          return { exitCode: 0, result: "" };
        },
      },
      fs: {
        uploadFile: async () => {},
        getFileDetails: async () => ({ size: 1_025 }),
        downloadFile: async () => new Uint8Array(1_025),
      },
    };
    const resolver = spyOn(bindings, "resolveSandboxBindingForSandbox").mockResolvedValue({
      provider: { get: async () => sandbox },
    } as never);
    const input = {
      sandboxId: "sandbox-a",
      sourceName: "report.docx",
      sourceBytes: new TextEncoder().encode("source"),
      timeoutSeconds: 30,
      maxBytes: 1_024,
    };
    try {
      expect(await convertOfficeToPdf(input)).toBeNull();
      expect(cleaned).toEqual([]);
      expect(await convertOfficeToPdf(input)).toBeNull();
      expect(cleaned).toHaveLength(1);
      expect(cleaned[0]).toStartWith("/tmp/useagent-office-preview-");
      expect(await convertOfficeToPdf(input)).toBeNull();
      expect(cleaned).toHaveLength(2);
    } finally {
      resolver.mockRestore();
    }
  });
});
