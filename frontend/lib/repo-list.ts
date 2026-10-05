"use client";

// The organisation's repositories from GET /api/repos, read once per page and shared by
// every consumer on it (the new-task repo picker and the composer's mention data both
// need the list on the same page). The GitHub credential stays server-side.

import { backendFetch } from "./backend-fetch";
import { type CachedRequest, cachedRequest } from "./cached-request";

export interface RepoListEntry {
  readonly full_name: string;
  readonly name?: string;
  readonly private?: boolean;
  readonly default_branch?: string;
}

/** How long a page reuses one repository list across the components that read it. */
export const REPO_LIST_TTL_MS = 60_000;

/** A failed request throws so it is never kept; an unconfigured deployment answers []. */
async function fetchRepoList(fetcher: typeof backendFetch): Promise<RepoListEntry[]> {
  const res = await fetcher("/api/repos");
  if (!res.ok) throw new Error(`repos failed: ${res.status}`);
  const data = (await res.json()) as { repos?: unknown };
  if (!Array.isArray(data.repos)) return [];
  return data.repos.flatMap((row): RepoListEntry[] => {
    const repo = row as Partial<RepoListEntry> | null;
    if (!repo || typeof repo.full_name !== "string") return [];
    return [{
      full_name: repo.full_name,
      ...(typeof repo.name === "string" ? { name: repo.name } : {}),
      ...(typeof repo.private === "boolean" ? { private: repo.private } : {}),
      ...(typeof repo.default_branch === "string" ? { default_branch: repo.default_branch } : {}),
    }];
  });
}

/** One repository request per page, shared by every consumer. */
export function createRepoListRequest(
  fetcher: typeof backendFetch = backendFetch,
  options: { readonly isShared?: () => boolean; readonly ttlMs?: number } = {},
): CachedRequest<RepoListEntry[]> {
  return cachedRequest(() => fetchRepoList(fetcher), { ttlMs: REPO_LIST_TTL_MS, ...options });
}

const repoListRequest = createRepoListRequest();

/** The shared list; a failed request throws (and is not kept), so each consumer keeps
 *  its own answer to a failure. `fresh` skips a settled value (a pending request is
 *  still joined): the sidebar's poll and its reload on a provider connection change
 *  read fresh, and what they read is what later consumers on the page reuse. */
export function loadRepoList(fresh = false): Promise<RepoListEntry[]> {
  return repoListRequest.get(fresh);
}
