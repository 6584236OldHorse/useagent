import { RiAddLine } from "@remixicon/react";
import type { Metadata } from "next";
import { ButtonLink } from "@/components/base/buttons/button";

export const metadata: Metadata = {
  title: "Page not found",
};

/**
 * Root 404: unknown routes and `notFound()` from a page (a missing or foreign
 * thread id) land here, on the theme tokens, with one way forward. Like the
 * root error page it renders no shell: every route ships this file's imports
 * on first load, public pages included.
 */
export default function NotFound() {
  return (
    <main id="main-content" className="flex min-h-dvh items-center justify-center bg-background-full p-6">
      <div className="flex w-full items-center justify-center">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <p className="text-mono-label text-text-tertiary">404</p>
          <h1 className="text-display-sm text-text-primary">Page not found</h1>
          <p className="text-body-2-regular text-text-secondary">
            This page does not exist, or the thread it pointed to is not in this workspace.
          </p>
          <ButtonLink
            href="/agent/new"
            variant="primary"
            size="small"
            leadingIcon={RiAddLine}
            className="mt-2 rounded-full"
          >
            Go to new thread
          </ButtonLink>
        </div>
      </div>
    </main>
  );
}
