// The input and output a runtime tool activity contributes to its durable step.
// The native runtime projects tool payloads before they reach this adapter, so
// two shapes need repair here: file changes whose path survives only in the
// projection's `files[]` list or in the Claude adapter's detail string, and
// command items whose captured output sits under `data.item`.

type Rec = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function stringField(value: unknown, key: string): string | null {
  const field = asRecord(value)?.[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

const FILE_PATH_KEYS = ["file_path", "filePath", "path", "filename"] as const;

/**
 * Every path a projected file change names. The runtime's activity projection
 * rewrites file tool inputs to `files:[{path}]` and its collector does not know
 * Claude's `file_path`, so a Claude edit reaches this adapter with no path in its
 * data at all; the only copy is the `detail` string the Claude adapter builds
 * from the tool input (`Write: {"file_path":"…"}`), read here as a last resort.
 */
export function runtimeFilePaths(input: unknown, detail: string | undefined): string[] {
  const paths: string[] = [];
  const push = (path: string | null): void => {
    if (path && !paths.includes(path)) paths.push(path);
  };
  const data = asRecord(input);
  const files = Array.isArray(data?.files) ? data.files : [];
  for (const entry of files) push(stringField(entry, "path"));
  for (const key of FILE_PATH_KEYS) push(stringField(data, key));
  if (paths.length === 0 && detail) {
    const match = /"(?:file_path|filePath|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(detail);
    if (match) {
      try {
        push(JSON.parse(`"${match[1]}"`) as string);
      } catch {
        // Not a JSON string literal after all; the row stays path-less.
      }
    }
  }
  return paths;
}

/** File-change input with one uniform shape for the UI: `file_path` names the
 * first file and `files` lists every one (the runtime's own entries kept when
 * present, since they may carry a change kind). */
function fileChangeInput(input: unknown, detail: string | undefined): unknown {
  const paths = runtimeFilePaths(input, detail);
  if (paths.length === 0) return input;
  const data = asRecord(input) ?? {};
  const files = Array.isArray(data.files) && data.files.length > 0
    ? data.files
    : paths.map((path) => ({ path }));
  return { ...data, file_path: paths[0], files };
}

/** Command input with the command line where the UI reads it. The runtime keeps
 * Codex's command under `data.item.command` (or `item.input.command`), which the
 * UI never walks; an input that already names its command is left alone. */
function commandInput(input: unknown, item: Rec | null): unknown {
  const data = asRecord(input);
  if (stringField(data, "command")) return input;
  const command = stringField(item, "command")
    ?? stringField(asRecord(item?.input), "command")
    ?? stringField(asRecord(item?.result), "command");
  return command ? { ...(data ?? {}), command } : input;
}

/** The captured output of a command item. The runtime nests Codex's command
 * result under `data.item` (`aggregatedOutput`, or `result.content`), while the
 * payload's `detail` is the command line itself; the UI wants the former. */
function commandOutput(item: Rec | null): string | null {
  return stringField(item, "aggregatedOutput") ?? stringField(asRecord(item?.result), "content");
}

/** The step's `input` and `output` for a tool activity of the given item type. */
export function runtimeStepIo(
  itemType: string | null,
  projection: { readonly input: unknown; readonly item: Rec | null },
  detail: string | undefined,
): { readonly input: unknown; readonly output: string | undefined } {
  if (itemType === "file_change") {
    return { input: fileChangeInput(projection.input, detail), output: detail };
  }
  if (itemType === "command_execution") {
    return {
      input: commandInput(projection.input, projection.item),
      output: commandOutput(projection.item) ?? detail,
    };
  }
  return { input: projection.input, output: detail };
}
