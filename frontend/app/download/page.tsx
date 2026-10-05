import { RiExternalLinkLine } from "@remixicon/react";
import type { Metadata } from "next";
import { ButtonLink } from "@/components/base/buttons/button";
import { AsteriskMark } from "@/components/foundations/brand/asterisk-mark";

const RELEASES_URL = "https://github.com/useagenthq/useagent-pro/releases/latest";

export const metadata: Metadata = {
  title: "UseAgent Desktop preview",
  description: "Release status for the UseAgent Desktop v0.0.5 preview.",
};

export default function DownloadPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background-primary-default px-6 py-16">
      <section className="w-full max-w-2xl">
        <div className="flex items-center gap-2 text-text-primary">
          <AsteriskMark className="size-5" />
          <span className="text-body-2-medium">UseAgent</span>
        </div>

        <p className="mt-16 text-mono-label text-text-tertiary">v0.0.5 desktop preview</p>
        <h1 className="mt-3 text-display-lg text-text-primary">UseAgent Desktop for Mac.</h1>
        <p className="mt-4 max-w-xl text-body-regular text-text-secondary">
          The desktop app connects your Mac as an isolated execution machine while your threads,
          memory, skills, and secrets stay on the control plane.
        </p>

        <div className="mt-10 rounded-2xl border border-border-button-default bg-background-secondary-default p-6">
          <h2 className="text-title-2-medium text-text-primary">Not yet published</h2>
          <p className="mt-2 text-body-2-regular text-text-secondary">
            Version v0.0.5 is still a preview. No downloadable DMG, signed build, notarized build,
            or production desktop release is available yet.
          </p>
          <ButtonLink
            className="mt-6 rounded-full"
            href={RELEASES_URL}
            leadingIcon={RiExternalLinkLine}
            rel="noreferrer"
            target="_blank"
          >
            View latest published release
          </ButtonLink>
          <p className="mt-3 text-caption-1-regular text-text-tertiary">
            The release repository is private. Repository access is required.
          </p>
        </div>
      </section>
    </main>
  );
}
