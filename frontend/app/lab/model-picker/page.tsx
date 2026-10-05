import type { Metadata } from "next";

import { AppShell } from "@/components/shell/app-shell";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";
import { ModelPickerShowcase } from "../model-picker-showcase";

export const metadata: Metadata = {
  title: "Model picker sample - useAgent",
  description:
    "The composer's model picker on a quiet page: the provider rail, quick search, radio rows and the effort selector, for visual review.",
};

/** The main lab page keeps live samples that move its scroll container, which
 *  closes any non-modal popover; this page holds still so the picker can be
 *  opened and photographed. */
export default function ModelPickerSamplePage() {
  return (
    <AppShell sidebar={<ThreadSidebar />} collapseSidebarAtTablet>
      <main className="mx-auto w-full max-w-3xl px-6 py-10">
        <ModelPickerShowcase />
      </main>
    </AppShell>
  );
}
