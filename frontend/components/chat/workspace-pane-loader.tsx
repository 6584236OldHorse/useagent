"use client";

import dynamic from "next/dynamic";

// The right-rail panes are mount-gated by their tab, so their JS is split too: the
// Workspace pane (workpiece editor surfaces + revision hook), the Editor pane (code
// surface + highlighter), the Terminal pane (log model + interactive terminal), the
// Desktop pane (screen stream + focus guard), the Changes pane (diff view) and the
// Details rail (plan, usage, git refs) load only when a user first opens that tab,
// never in the base session bundle. The Files pane stays in it on purpose: it is the
// tab a thread with files opens on, so splitting it would only delay the first paint.
function paneLoading(label: string) {
  return function PaneLoading() {
    return (
      <div className="grid h-full place-items-center p-6 text-body-2-regular text-text-secondary">
        {label}
      </div>
    );
  };
}

export const WorkspacePane = dynamic(
  () => import("@/components/chat/workspace-pane").then((mod) => mod.WorkspacePane),
  { ssr: false, loading: paneLoading("Loading workspace...") },
);

export const EditorPane = dynamic(
  () => import("@/components/chat/editor-pane").then((mod) => mod.EditorPane),
  { ssr: false, loading: paneLoading("Loading editor...") },
);

export const TerminalPane = dynamic(
  () => import("@/components/chat/terminal-pane").then((mod) => mod.TerminalPane),
  { ssr: false, loading: paneLoading("Loading terminal...") },
);

export const DesktopPane = dynamic(
  () => import("@/components/chat/desktop-pane").then((mod) => mod.DesktopPane),
  { ssr: false, loading: paneLoading("Loading desktop...") },
);

export const DiffPane = dynamic(
  () => import("@/components/chat/diff-pane").then((mod) => mod.DiffPane),
  { ssr: false, loading: paneLoading("Loading changes...") },
);

export const SessionDetailsRail = dynamic(
  () => import("@/components/chat/session-details-rail").then((mod) => mod.SessionDetailsRail),
  { ssr: false, loading: paneLoading("Loading details...") },
);
