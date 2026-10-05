/** The clock time a settled answer landed, shown beside its copy affordance.
 *  Rendered on the client only in practice (turns arrive by fetch), so the
 *  viewer's locale and zone apply; the hydration guard covers a server pass. */
export function AnsweredAt({ iso }: { iso: string }) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <time
      dateTime={iso}
      suppressHydrationWarning
      className="text-caption-1-regular text-text-tertiary tabular-nums"
    >
      {date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
    </time>
  );
}
