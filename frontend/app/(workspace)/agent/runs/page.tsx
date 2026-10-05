import type { Metadata } from "next";
import { fetchRuns, type Run } from "./runs-data";
import { RunsList } from "./runs-list";

export const metadata: Metadata = {
  title: "All threads",
  description: "Live agent runs from the useAgent orchestrator.",
};

// Always render fresh — the runs list is live data.
export const dynamic = "force-dynamic";

export default async function AgentRunsPage() {
  let initialRuns: Run[] = [];
  let initialError = false;

  try {
    initialRuns = await fetchRuns();
  } catch {
    initialError = true;
  }

  return (
    <RunsList initialRuns={initialRuns} initialError={initialError} />
  );
}
