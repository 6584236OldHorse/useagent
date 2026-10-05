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

/**
 * Watches a landing on the composer page: the first-run page opens only when
 * the workspace check answers yes and the composer holds no draft at that
 * moment, whenever the draft was made (while the session was still loading,
 * from a deep link, from a menu action), so nothing is ever replaced from under
 * a person. Returns the cleanup for an unmount.
 */
export function watchLanding(deps: {
  readonly userId: string;
  readonly listWorkspaces: () => Promise<Workspace[]>;
  /** The composer's own state: prompt text or attachments present right now. */
  readonly hasDraft: () => boolean;
  readonly open: () => void;
}): () => void {
  if (firstRunSkipped(deps.userId)) return () => {};
  let cancelled = false;
  deps
    .listWorkspaces()
    .then((workspaces) => {
      if (!cancelled && !deps.hasDraft() && firstRunApplies(workspaces.find((workspace) => workspace.active))) {
        deps.open();
      }
    })
    .catch(() => undefined); // the landing page stands whatever the answer
  return () => {
    cancelled = true;
  };
}
