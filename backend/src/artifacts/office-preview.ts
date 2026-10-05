import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  DOCX_CONTENT_TYPE,
  normalizeArtifactContentType,
  PPTX_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
} from "@useagent/artifact-workspace";
import { resolveRunSandbox, resolveSandboxBindingForSandbox } from "../sandboxes/binding";
import { awaitWithSignal } from "../util/abortable-operation";

type RunSandboxAuthority = Parameters<typeof resolveRunSandbox>[0];

/** The Office binary content types LibreOffice can render to a PDF preview. */
const OFFICE_PREVIEW_CONTENT_TYPES = new Set([
  DOCX_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  PPTX_CONTENT_TYPE,
]);

/** Bounds for the best-effort in-sandbox conversion. A preview must never dominate
 * a publish, so the soffice run is time-boxed and the resulting PDF is size-capped. */
export const OFFICE_PREVIEW_TIMEOUT_SECONDS = 30;
export const OFFICE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

/** True when this content type is an Office binary a PDF preview is attempted for. */
export function isOfficePreviewContentType(contentType: string): boolean {
  return OFFICE_PREVIEW_CONTENT_TYPES.has(normalizeArtifactContentType(contentType));
}

export interface OfficePreviewInput {
  readonly sandboxId: string;
  readonly run?: RunSandboxAuthority;
  readonly sourceName: string;
  readonly sourceBytes: Uint8Array;
  readonly timeoutSeconds: number;
  readonly maxBytes: number;
}

/** Convert an Office file in a sandbox to PDF bytes, or null when it cannot be
 * produced (no soffice, a non-zero exit, an oversized or empty output). Never
 * throws for a conversion failure - a missing preview is a normal outcome. */
export type OfficePreviewConverter = (input: OfficePreviewInput) => Promise<Uint8Array | null>;

/** Shell-single-quote a path so an odd filename cannot break the soffice command.
 * The path already lives in the agent's own sandbox, so this is correctness (not a
 * privilege boundary - the agent can run any command there anyway). */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function providerConvert(input: OfficePreviewInput): Promise<Uint8Array | null> {
  const sandbox = input.run
    ? await resolveRunSandbox(input.run)
    : await (await resolveSandboxBindingForSandbox(input.sandboxId)).provider.get(input.sandboxId);
  const extension = /\.(docx|xlsx|pptx)$/i.exec(basename(input.sourceName))?.[0].toLowerCase() ?? ".office";
  const root = `/tmp/useagent-office-preview-${randomUUID()}`;
  const sourcePath = `${root}/input${extension}`;
  const outPath = `${root}/input.pdf`;
  const profileUrl = `file://${root}/profile`;
  let acquired = false;
  try {
    const directory = await sandbox.process.executeCommand(
      `mkdir -m 700 -- ${shellQuote(root)}`,
      undefined,
      undefined,
      input.timeoutSeconds,
    );
    if ((directory.exitCode ?? 1) !== 0) return null;
    acquired = true;
    await sandbox.fs.uploadFile(
      Buffer.from(input.sourceBytes),
      sourcePath,
      input.timeoutSeconds,
    );
    const command =
      `soffice --headless --nolockcheck ${shellQuote(`-env:UserInstallation=${profileUrl}`)} ` +
      `--convert-to pdf --outdir ${shellQuote(root)} ${shellQuote(sourcePath)}`;
    const result = await sandbox.process.executeCommand(
      command,
      undefined,
      undefined,
      input.timeoutSeconds,
    );
    if ((result.exitCode ?? 1) !== 0) return null;
    const info = await sandbox.fs.getFileDetails(outPath);
    if (Number((info as { size?: number }).size ?? 0) > input.maxBytes) return null;
    // The converted PDF is read within the same bound as the conversion: a
    // stream that never ends yields no preview instead of holding the caller.
    const bytes = await awaitWithSignal(
      () => sandbox.fs.downloadFile(outPath),
      AbortSignal.timeout(input.timeoutSeconds * 1000),
    );
    if (bytes.length === 0 || bytes.length > input.maxBytes) return null;
    return new Uint8Array(bytes);
  } finally {
    if (acquired) {
      await sandbox.process.executeCommand(
        `rm -rf -- ${shellQuote(root)}`,
        undefined,
        undefined,
        input.timeoutSeconds,
      ).catch(() => undefined);
    }
  }
}

let override: OfficePreviewConverter | null = null;

/** TEST ONLY: swap in a fake converter so no live sandbox with soffice is needed. */
export function setOfficePreviewConverterForTest(fn: OfficePreviewConverter | null): void {
  override = fn;
}

/** Render an Office file in the sandbox to a PDF preview, or null on any failure
 * (best-effort; the caller treats null as "no preview, download-only as before"). */
export async function convertOfficeToPdf(input: OfficePreviewInput): Promise<Uint8Array | null> {
  try {
    return await (override ?? providerConvert)(input);
  } catch {
    return null;
  }
}
