import type { RunConnector } from "@useagent/agent-client";
import { connectorLabel, connectorMarkFor } from "@/components/foundations/icons/vendor-marks";
import { cx } from "@/utils/cx";

/** The small connector mark that opens the thread where it started (a Slack
 *  thread's permalink), on the session bar and the rail row. Nothing renders for
 *  a thread typed in the product or one whose link is unknown. */
export function OriginLink({
  connector,
  className,
}: {
  readonly connector?: RunConnector | null;
  readonly className?: string;
}) {
  if (!connector?.permalink) return null;
  const Mark = connectorMarkFor(connector.source);
  const label = `Open in ${connectorLabel(connector.source)}`;
  return (
    <a
      href={connector.permalink}
      target="_blank"
      rel="noreferrer"
      title={label}
      aria-label={label}
      data-session-ui="origin-link"
      className={cx(
        "text-text-tertiary hover:text-text-primary flex size-6 shrink-0 items-center justify-center rounded-lg transition-colors",
        className,
      )}
    >
      <Mark className="size-3.5" />
    </a>
  );
}
