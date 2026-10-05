import { posix } from "node:path";

export interface OutputLink {
  readonly start: number;
  readonly end: number;
  readonly path: string;
  readonly image: boolean;
}

/** Only explicit Markdown destinations declare output. Code examples and bare
 * paths are not permission to publish files from a retained workspace. */
export function explicitOutputLinks(markdown: string, workspaceRoot: string): OutputLink[] {
  // Preserve offsets while excluding fenced and inline code from discovery.
  const masked = markdown.replace(
    /(^ {0,3}(`{3,}|~{3,})[^\n]*\n)[\s\S]*?(?:^ {0,3}\2[ \t]*$|$(?![\s\S]))|(`+)[\s\S]*?\3/gm,
    (code) => code.replace(/[^\n]/g, " "),
  );
  const links: OutputLink[] = [];
  const starts = /(!?\[(?:\\.|[^\]\\\n])*\])\([ \t]*/g;
  for (const match of masked.matchAll(starts)) {
    const destinationStart = match.index + match[0].length;
    let start = destinationStart;
    let end = start;
    if (masked[start] === "<") {
      start++;
      end = masked.indexOf(">", start);
      if (end < 0 || masked.slice(start, end).includes("\n")) continue;
      if (!/^[ \t]*(?:["'][^\n]*["'][ \t]*)?\)/.test(masked.slice(end + 1))) continue;
    } else {
      let depth = 0;
      while (end < masked.length) {
        const char = masked[end];
        if (char === "\\" && end + 1 < masked.length) { end += 2; continue; }
        if (char === "(") depth++;
        if (char === ")") {
          if (depth === 0) break;
          depth--;
        }
        if (/\s/.test(char!)) break;
        end++;
      }
      if (depth !== 0 || !/^(?:[ \t]+["'][^\n]*["'][ \t]*)?\)/.test(masked.slice(end))) continue;
    }
    const raw = markdown.slice(start, end).replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1");
    const path = outputPath(raw, workspaceRoot);
    if (path !== null) links.push({ start, end, path, image: match[1]!.startsWith("!") });
  }
  return links;
}

function outputPath(destination: string, workspaceRoot: string): string | null {
  let path = destination;
  if (/^file:/i.test(path)) {
    path = path.slice("file:".length);
    if (path.startsWith("//")) {
      if (!path.startsWith("///")) throw new Error("invalid local output URL");
      path = path.slice(2);
    }
    if (path.includes("?") || path.includes("#")) throw new Error("invalid local output URL");
    path = decodeURIComponent(path);
  } else if (/^sandbox:/i.test(path)) {
    path = decodeURIComponent(path.slice("sandbox:".length));
  } else {
    if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//") || path.startsWith("#")) return null;
    // Absolute application links are not filesystem locators. Only the attached
    // workspace's namespace is eligible without an explicit file/sandbox scheme.
    if (path.startsWith("/") && path !== workspaceRoot && !path.startsWith(`${workspaceRoot}/`)) return null;
    if (!path.startsWith("/")) return null;
    path = decodeURIComponent(path);
  }
  // Never normalize away traversal or a mismatched provider root. The existing
  // publisher also checks realpath, protected locations, bytes, and tenant scope.
  if (!posix.isAbsolute(path) || path.length > 4096 || path.includes("\0")) {
    throw new Error("invalid local output path");
  }
  return path;
}

export function replaceOutputLinks(
  markdown: string,
  links: readonly OutputLink[],
  urls: ReadonlyMap<string, { readonly preview: string; readonly download: string }>,
): string {
  let result = markdown;
  for (const link of [...links].reverse()) {
    const url = urls.get(link.path);
    if (!url) throw new Error("missing published output URL");
    result = result.slice(0, link.start) + (link.image ? url.preview : url.download) + result.slice(link.end);
  }
  return result;
}
