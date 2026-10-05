import type { Metadata } from "next";
import { fetchSkills } from "@/app/(library)/skills/skills-api";
import { mockSkills } from "@/app/(library)/skills/skills-data";
import { PlaybooksView } from "./playbooks-view";

export const metadata: Metadata = {
  title: "Playbooks",
  description: "Structured procedures useAgent follows as guidance for repeatable work.",
};

export default async function PlaybooksPage() {
  // SSR the real playbooks when the backend is up. A failed fetch is surfaced as
  // `initialError` (a distinct, retryable state) - NOT swallowed into the empty
  // seed, so an outage never reads as "no playbooks yet". Same substrate as
  // Skills, scoped to kind=playbook.
  let initialPlaybooks = mockSkills;
  let initialLive = false;
  let initialError = false;
  try {
    initialPlaybooks = await fetchSkills("playbook");
    initialLive = true;
  } catch {
    initialError = true;
  }

  return (
    <PlaybooksView
        initialPlaybooks={initialPlaybooks}
        initialLive={initialLive}
        initialError={initialError}
      />
  );
}
