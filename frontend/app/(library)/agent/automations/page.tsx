import type { Metadata } from "next";
import { AutomationsView } from "@/app/agent/schedules/automations-view";

export const metadata: Metadata = {
  title: "Automations",
  description: "Recurring and triggered runs UseAgent starts on its own.",
};

export default function AutomationsPage() {
  return (
    <AutomationsView />
  );
}
