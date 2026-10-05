"use client";

import dynamic from "next/dynamic";

// The right-rail panes are mount-gated by their tab, so their JS is split too: the
// Workspace pane (workpiece editor surfaces + revision hook), the Editor pane (code
// surface + highlighter) and the Terminal pane (log model + interactive terminal)
// load only when a user first opens that tab, never in the base session bundle.
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
