import type { RunConnector } from "@useagent/agent-client";
import { Avatar } from "@/components/base/avatar/avatar";
import { connectorLabel, connectorMarkFor } from "@/components/foundations/icons/vendor-marks";

/** Who sent a turn that arrived through a connector: the sender's display name
 *  and avatar as the channel showed them, with the connector's mark on the
 *  avatar. Renders nothing for a turn typed in the product. */
export function TurnSender({ connector }: { readonly connector?: RunConnector | null }) {
  if (!connector) return null;
  const Mark = connectorMarkFor(connector.source);
  const channel = connectorLabel(connector.source);
  const name = connector.sender_name ?? `${channel} member`;
  const via = `Sent from ${channel}`;
  return (
    <div className="flex items-center justify-end gap-2" data-testid="turn-sender">
      <span className="truncate text-body-2-medium text-text-primary">{name}</span>
      <span className="relative shrink-0">
        <Avatar
          size="xs"
          src={connector.sender_avatar_url ?? undefined}
          alt=""
          initials={name.trim().charAt(0).toUpperCase() || "?"}
        />
        <span
          role="img"
          aria-label={via}
          title={via}
          className="bg-bg-white-0 ring-border-button-default text-text-secondary absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full ring-1"
        >
          <Mark className="size-2.5" />
        </span>
      </span>
    </div>
  );
}
