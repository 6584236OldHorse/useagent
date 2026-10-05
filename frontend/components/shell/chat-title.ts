// The rail's title for a chat, from the first thing the person asked: the
// first line outside any code fence, its markdown chrome, a leading
// interjection ("Nice.", "Thanks!") and the ask-around ("please", "can you")
// dropped, cut at the end of the first sentence, then near 48 characters at a
// word boundary, and capitalised. Deterministic on purpose: the event log
// carries no title (nothing writes one yet), so the same prompt always reads
// the same.

import { cleanPrompt } from "@/components/chat/types";

const MAX_CHARS = 48;
const INTERJECTION =
  /^(?:nice|thanks|thank you|great|cool|perfect|awesome|good|ok(?:ay)?|hi|hello|hey)[.!,]+\s+/i;
const FILLER =
  /^(?:please|pls|hey|hi|hello|ok(?:ay)?|so|now|can you|could you|would you|will you|i want you to|i need you to|i'd like you to|i would like you to|let's|lets)\b(?:[\s,:!-]+|$)/i;
const TRAILING = /[\s.!?,;:-]+$/;

/** The first non-empty line that is not inside a code fence; the first
 *  non-empty line at all when the whole prompt is fenced. */
function askLine(prompt: string): string {
  const lines = prompt.split("\n").map((line) => line.trim());
  let fenced = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (line && !fenced) return line;
  }
  return lines.find((line) => line && !line.startsWith("```")) ?? "";
}

export function chatTitle(prompt: string | null | undefined): string {
  let line = askLine(cleanPrompt(prompt ?? ""))
    .replace(/^[#>*\-\s]+/, "")
    .replace(/[`*_]+/g, "")
    .trim()
    .replace(INTERJECTION, "");
  for (let pass = 0; pass < 2; pass += 1) line = line.replace(FILLER, "");
  const sentence = /^(.{12,}?[.!?])(?:\s|$)/.exec(line)?.[1];
  if (sentence) line = sentence;
  line = line.replace(TRAILING, "");
  if (line.length > MAX_CHARS) {
    const head = line.slice(0, MAX_CHARS + 1);
    const space = head.lastIndexOf(" ");
    const cut = space > MAX_CHARS / 2 ? head.slice(0, space) : head.slice(0, MAX_CHARS);
    line = `${cut.replace(TRAILING, "")}…`;
  }
  if (!line) return "New chat";
  return line.charAt(0).toUpperCase() + line.slice(1);
}
