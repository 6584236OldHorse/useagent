"use client";

import { useState } from "react";
import { Button } from "@/components/base/buttons/button";

export function DesktopSignIn({ openExternal }: { openExternal: (url: string) => void }) {
  const [opened, setOpened] = useState(false);
  return (
    <section className="space-y-5" aria-label="Desktop sign-in">
      <h1 className="text-display-sm text-text-primary">Sign in to useAgent</h1>
      <p className="text-body-regular text-text-secondary">
        Continue in your browser to sign in. You will return here when finished.
      </p>
      <Button
        className="rounded-full"
        onClick={() => {
          openExternal(new URL("/desktop-auth", window.location.origin).href);
          setOpened(true);
        }}
      >
        Continue in browser
      </Button>
      {opened ? (
        <p role="status" className="text-body-2-regular text-text-secondary">
          Finish sign-in in your browser, then approve connecting this desktop app.
        </p>
      ) : null}
    </section>
  );
}
