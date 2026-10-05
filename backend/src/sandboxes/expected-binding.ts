import type { SandboxProviderKind } from "@useagent/sandbox-contract";

export interface ExpectedSandboxBinding {
  readonly version: 1;
  readonly sandboxId: string;
  readonly provider: SandboxProviderKind;
  readonly credential: "env" | "user";
  readonly ownerOrgId: string;
  readonly ownerUserId: string | null;
  readonly credentialGeneration: string;
}

export class InvalidExpectedSandboxBindingError extends Error {
  readonly code = "invalid_expected_sandbox_binding" as const;

  constructor() {
    super("invalid expected sandbox binding");
  }
}

export class ExpectedSandboxMismatchError extends Error {
  readonly code = "expected_sandbox_mismatch" as const;

  constructor() {
    super("The accepted sandbox binding is no longer available; no replacement was created.");
  }
}

const providers: readonly SandboxProviderKind[] = ["daytona", "cube", "box", "local"];

function identifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: identity fields must reject control characters.
  return normalized && normalized.length <= 255 && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

export function parseExpectedSandboxBinding(value: unknown): ExpectedSandboxBinding | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidExpectedSandboxBindingError();
  }
  const record = value as Record<string, unknown>;
  const sandboxId = identifier(record.sandboxId);
  const ownerOrgId = identifier(record.ownerOrgId);
  const ownerUserId = identifier(record.ownerUserId);
  const credentialGeneration = typeof record.credentialGeneration === "string"
    ? record.credentialGeneration.toLowerCase()
    : "";
  if (
    Object.keys(record).length !== 7 ||
    record.version !== 1 ||
    sandboxId === null ||
    typeof record.provider !== "string" ||
    !providers.includes(record.provider as SandboxProviderKind) ||
    (record.credential !== "env" && record.credential !== "user") ||
    ownerOrgId === null ||
    (record.credential === "env"
      ? record.ownerUserId !== null
      : ownerUserId === null) ||
    !/^[0-9a-f]{64}$/.test(credentialGeneration)
  ) {
    throw new InvalidExpectedSandboxBindingError();
  }
  return {
    version: 1,
    sandboxId,
    provider: record.provider as SandboxProviderKind,
    credential: record.credential,
    ownerOrgId,
    ownerUserId: record.credential === "env" ? null : ownerUserId,
    credentialGeneration,
  };
}
