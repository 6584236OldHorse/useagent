// The rail's title for a chat, from the first thing the person asked: one
// line, its markdown chrome and a leading "please" or "can you" dropped, cut
// at the end of the first sentence, then near 48 characters at a word
// boundary, and capitalised. Deterministic on purpose: the event log carries
// no title (nothing writes one yet), so the same prompt always reads the same.

import { cleanPrompt, firstLine } from "@/components/chat/types";

const MAX_CHARS = 48;
const FILLER =
  /^(?:please|pls|hey|hi|hello|ok(?:ay)?|so|now|can you|could you|would you|will you|i want you to|i need you to|i'd like you to|i would like you to|let's|lets)\b[\s,:!-]*/i;
const TRAILING = /[\s.!?,;:-]+$/;

export function chatTitle(prompt: string | null | undefined): string {
  let line = firstLine(cleanPrompt(prompt ?? ""))
    .replace(/^[#>*\-\s]+/, "")
    .replace(/[`*_]+/g, "")
    .trim();
  // A short opening interjection ("Nice.", "Thanks!") is not the ask.
  line = line.replace(/^[^.!?]{1,11}[.!?]+\s+/, "");
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
