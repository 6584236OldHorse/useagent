"use client";

import { SurfaceChooser } from "@/components/chat/surface-chooser";

// The rail's empty state in two states: a thread with work, and a fresh one.
export default function SurfaceChooserLab() {
  return (
    <div className="grid min-h-screen grid-cols-1 gap-px bg-border-button-default md:grid-cols-2">
      <section className="h-[640px] bg-background-primary-default">
        <SurfaceChooser agentsAvailable={false} diffAvailable facts={["12 commands run", "3 file changes"]} onSelect={() => {}} />
      </section>
      <section className="h-[640px] bg-background-primary-default">
        <SurfaceChooser agentsAvailable={false} diffAvailable={false} onSelect={() => {}} />
      </section>
    </div>
  );
}
