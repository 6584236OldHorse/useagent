import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { backendFetch } from "@/lib/backend-fetch";

// The component lab is a developer surface. The backend decides who may see it
// (LAB_ACCOUNTS in production, everyone in development); anyone else gets the
// same 404 as a page that does not exist. Fails closed when the backend is down.
export default async function LabLayout({ children }: { children: ReactNode }) {
  const allowed = await backendFetch("/api/lab/access", { signal: AbortSignal.timeout(5_000) })
    .then((response) => response.ok)
    .catch(() => false);
  if (!allowed) notFound();
  return children;
}
