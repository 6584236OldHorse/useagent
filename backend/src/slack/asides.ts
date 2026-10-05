/**
 * What a Slack message asks of the bot before it is a prompt. Two escape
 * hatches people know from other Slack agents: an aside, "(aside)" or
 * "!aside" first, is talk for the humans in the thread and the bot ignores
 * it; "mute" and "unmute" on their own flip whether the bot listens to the
 * thread at all. Only the text decides; the bot's own mention is stripped
 * before this runs.
 */
export type SlackThreadControl = "aside" | "mute" | "unmute";

const ASIDE = /^\s*(?:\(aside\)|!aside(?![a-z0-9]))/i;
const CONTROL = /^\s*(mute|unmute)\s*[.!]*\s*$/i;

export function slackThreadControl(text: string): SlackThreadControl | null {
  if (ASIDE.test(text)) return "aside";
  const word = CONTROL.exec(text)?.[1]?.toLowerCase();
  return word === "mute" || word === "unmute" ? word : null;
}
