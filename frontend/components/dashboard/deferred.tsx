"use client";

import dynamic from "next/dynamic";

// The chart and table libraries are the heaviest code on the dashboard and none
// of it is needed for the first paint. Client-only dynamic imports keep their
// chunks out of the page's initial scripts: the stat cards paint, then these
// load and fill in.
const skeleton = (height: string) => () => (
  <div aria-hidden className={`${height} w-full animate-pulse rounded-2xl bg-background-secondary-default`} />
);

export const DeferredAnalyticsBand = dynamic(() => import("./analytics-band").then((m) => m.AnalyticsBand), {
  ssr: false,
  loading: skeleton("h-64"),
});

export const DeferredRecentRunsTable = dynamic(() => import("./recent-runs-table").then((m) => m.RecentRunsTable), {
  ssr: false,
  loading: skeleton("h-72"),
});
