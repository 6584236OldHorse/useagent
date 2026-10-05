"use client";

import { useEffect, useState } from "react";

/** The clock time a settled answer landed, shown beside its copy affordance.
 *  Formatted only after mount, so the viewer's own locale and zone apply and a
 *  server pass never paints the server's clock. */
export function AnsweredAt({ iso }: { iso: string }) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    const date = new Date(iso);
    setLabel(
      Number.isNaN(date.getTime())
        ? null
        : date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    );
  }, [iso]);
  if (!label) return null;
  return (
    <time dateTime={iso} className="text-caption-1-regular text-text-tertiary tabular-nums">
      {label}
    </time>
  );
}
