import type { RunConnector } from "@useagent/agent-client";
import { connectorLabel, connectorMarkFor } from "@/components/foundations/icons/vendor-marks";
import { cx } from "@/utils/cx";

type ChannelKind = NonNullable<RunConnector["channel_kind"]>;

/** The kind of Slack conversation a thread came from: the stamp's, else the
 *  channel id in the permalink (threads stamped before the kind existed; their
 *  channel names stay unknown). */
function channelKindOf(connector: RunConnector): ChannelKind | null {
  if (connector.channel_kind) return connector.channel_kind;
  const prefix = connector.permalink?.match(/\/archives\/([A-Z])/)?.[1];
  if (prefix === "D") return "dm";
  if (prefix === "G") return "private_channel";
  if (prefix === "C") return "channel";
  return null;
}

/** What the chip says beside the mark (null: the mark alone) and the sentence
 *  behind it. A DM's permalink opens only for the person in that DM, which the
 *  sentence says so nobody else keeps trying it. */
function originWords(connector: RunConnector): { text: string | null; title: string } {
  const label = connectorLabel(connector.source);
  const kind = connector.source === "slack" ? channelKindOf(connector) : null;
  if (kind === "dm") {
    const sender = connector.sender_name;
    return {
      text: "DM",
      title: sender
        ? `${label} DM from ${sender}. The link opens only for them`
        : `${label} DM. The link opens only for its sender`,
    };
  }
  if (kind === "group_dm") {
    return { text: "Group DM", title: `${label} group DM. The link opens only for its members` };
  }
  if (kind === "channel" || kind === "private_channel") {
    const name = connector.channel_name ? `#${connector.channel_name}` : null;
    return {
      text: name ?? (kind === "channel" ? "Channel" : "Private channel"),
      title: name ? `Open ${name} in ${label}` : `Open in ${label}`,
    };
  }
  return { text: null, title: `Open in ${label}` };
}

/** The small connector mark that opens the thread where it started (a Slack
 *  thread's permalink), with what kind of conversation that is: a DM, a group
 *  DM or the channel's name. The rail row keeps the mark alone (`compact`).
 *  Nothing renders for a thread typed in the product or one whose link is
 *  unknown. */
export function OriginLink({
  connector,
  compact = false,
  className,
}: {
  readonly connector?: RunConnector | null;
  readonly compact?: boolean;
  readonly className?: string;
}) {
  if (!connector?.permalink) return null;
  const Mark = connectorMarkFor(connector.source);
  const { text, title } = originWords(connector);
  const showText = !compact && text !== null;
  return (
    <a
      href={connector.permalink}
      target="_blank"
      rel="noreferrer"
      title={title}
      aria-label={title}
      data-session-ui="origin-link"
      className={cx(
        "text-text-tertiary hover:text-text-primary flex h-6 shrink-0 items-center justify-center gap-1 rounded-lg transition-colors",
        showText ? "px-1.5" : "w-6",
        className,
      )}
    >
      <Mark className="size-3.5" />
      {showText && <span className="text-caption-1-medium whitespace-nowrap">{text}</span>}
    </a>
  );
}
