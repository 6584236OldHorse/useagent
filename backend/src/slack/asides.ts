/**
 * What a Slack message asks of the bot before it is a prompt. Two escape
 * hatches people know from other Slack agents: an aside, "(aside)" or
 * "!aside" first, is talk for the humans in the thread and the bot ignores
 * it; "mute" and "unmute" on their own flip whether the bot listens to the
 * thread at all. Only the text decides; the bot's own mention is stripped
 * before this runs.
 */
import { enqueueAddReaction } from "./outbox";
import { setSlackThreadMuted } from "./repo";

export type SlackThreadControl = "aside" | "mute" | "unmute";

const ASIDE = /^\s*(?:\(aside\)|!aside(?![a-z0-9]))/i;
const CONTROL = /^\s*(mute|unmute)\s*[.!]*\s*$/i;

export function slackThreadControl(text: string): SlackThreadControl | null {
  if (ASIDE.test(text)) return "aside";
  const word = CONTROL.exec(text)?.[1]?.toLowerCase();
  return word === "mute" || word === "unmute" ? word : null;
}

/** "mute" or "unmute" from a linked member: inside a thread the bot roots it
 *  flips the thread and reacts once, keyed by the message so a redelivery never
 *  reacts twice; outside a rooted thread the word has nothing to act on and is
 *  not a prompt either. Either way the message settles. */
export async function settleThreadControl(
  control: Exclude<SlackThreadControl, "aside">,
  input: {
    readonly teamId: string;
    readonly channel: string;
    readonly ts: string;
    readonly orgId: string;
    readonly threadTs: string;
    readonly rooted: boolean;
  },
): Promise<{ readonly status: "permanent_noop"; readonly reason: string }> {
  const { teamId, channel, ts, orgId, threadTs } = input;
  if (!input.rooted) {
    console.log(`[slack] ${control} outside a rooted thread ignored: ${teamId}:${channel}:${ts}`);
    return { status: "permanent_noop", reason: `${control}_without_thread` };
  }
  await setSlackThreadMuted({ teamId, channel, threadTs, orgId }, control === "mute");
  await enqueueAddReaction({
    idempotencyKey: `slack-ack:${teamId}:${channel}:${ts}`,
    orgId,
    teamId,
    channel,
    timestamp: ts,
    name: control === "mute" ? "no_bell" : "bell",
  });
  return { status: "permanent_noop", reason: `thread_${control}` };
}
