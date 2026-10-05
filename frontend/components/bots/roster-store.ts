import type { ApiBot } from "./types";

type Listener = (bots: ApiBot[]) => void;

let published: ApiBot[] | null = null;
const listeners = new Set<Listener>();

/**
 * The bots page renders the roster the server fetched for this navigation and
 * hands it here, so the shell's roster column (a persistent layout, whose own
 * server prop goes stale after the first render) follows every page hop
 * without asking the backend again.
 */
export function publishRoster(bots: ApiBot[]): void {
  published = bots;
  for (const listener of listeners) listener(bots);
}

export function subscribeRoster(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishedRoster(): ApiBot[] | null {
  return published;
}
