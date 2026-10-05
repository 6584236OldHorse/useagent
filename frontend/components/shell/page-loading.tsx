/**
 * Content-area skeleton for a route group's `loading.tsx`. It renders INSIDE the
 * persistent shell, so a hop keeps the sidebar and chrome mounted and only the
 * page area shimmers - a quiet page-shaped placeholder, never a full-viewport
 * takeover.
 */
export function PageLoading() {
  return (
    <div
      className="mx-auto flex w-full max-w-[1100px] flex-col gap-6 px-6 py-8 sm:px-10 sm:py-10 motion-safe:animate-pulse"
      role="status"
      aria-label="Loading page"
    >
      <div className="h-7 w-48 rounded-lg bg-background-secondary-default" />
      <div className="h-4 w-2/3 rounded-lg bg-background-secondary-default" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="h-28 rounded-xl bg-background-secondary-default" />
        <div className="h-28 rounded-xl bg-background-secondary-default" />
        <div className="h-28 rounded-xl bg-background-secondary-default" />
      </div>
      <div className="flex flex-col gap-3">
        <div className="h-4 w-3/5 rounded-lg bg-background-secondary-default" />
        <div className="h-4 w-1/2 rounded-lg bg-background-secondary-default" />
        <div className="h-4 w-2/5 rounded-lg bg-background-secondary-default" />
      </div>
    </div>
  );
}
