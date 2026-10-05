import type { Workspace } from "./auth";

/**
 * A workspace nobody has made theirs yet: still named as it was created, its
 * creator the only member. The first-run page (/welcome) offers a name and
 * invitations; the landing page sends a person there once per browser.
 */
export function firstRunApplies(workspace: Workspace | undefined): workspace is Workspace {
  return (
    workspace !== undefined && workspace.defaultName && workspace.members === 1 && workspace.role === "owner"
  );
}

const skippedKey = (userId: string) => `first-run-skipped:${userId}`;
/** Held for the page's lifetime too, so a browser that refuses storage cannot
 *  bounce between the landing page and /welcome: client-side navigation keeps it. */
const skippedHere = new Set<string>();

/** Per browser: a person who chose to continue is not sent back to the page. */
export function firstRunSkipped(userId: string): boolean {
  if (skippedHere.has(userId)) return true;
  try {
    return window.localStorage.getItem(skippedKey(userId)) !== null;
  } catch {
    return false;
  }
}

export function markFirstRunSkipped(userId: string): void {
  skippedHere.add(userId);
  try {
    window.localStorage.setItem(skippedKey(userId), new Date().toISOString());
  } catch {
    // A browser that refuses storage shows the page again after a full reload; nothing else depends on it.
  }
}

/** The composer page's state: pending until the first-run check settles, then
 *  stay (render the composer) or open (the first-run page). */
export type LandingDecision = "pending" | "stay" | "open";

/** A decision settles once: after the composer is up nothing reopens the page. */
export function settleLanding(current: LandingDecision, outcome: "stay" | "open"): LandingDecision {
  return current === "pending" ? outcome : current;
}

/**
 * Runs the first-run check for a landing on the composer page and reports
 * exactly one outcome: open the first-run page, or stay and render the
 * composer. A person who chose to continue before stays without a request; a
 * failed check stays too (the landing page stands whatever the answer).
 * Returns the cleanup for an unmount, after which nothing is reported.
 */
export function watchLanding(deps: {
  readonly userId: string;
  readonly listWorkspaces: () => Promise<Workspace[]>;
  readonly settle: (outcome: "stay" | "open") => void;
  /** Asked when the answer arrives: is the page this check was started for
   *  still the one in front of the person, with no navigation requested from
   *  it meanwhile? A pending navigation has nothing rendered yet, so this is
   *  what keeps the first-run page from superseding it. */
  readonly stillHere: () => boolean;
}): () => void {
  let cancelled = false;
  if (firstRunSkipped(deps.userId)) {
    deps.settle("stay");
    return () => {};
  }
  deps
    .listWorkspaces()
    .then((workspaces) => {
      if (cancelled) return;
      deps.settle(deps.stillHere() && firstRunApplies(workspaces.find((workspace) => workspace.active)) ? "open" : "stay");
    })
    .catch(() => {
      if (!cancelled) deps.settle("stay");
    });
  return () => {
    cancelled = true;
  };
}
