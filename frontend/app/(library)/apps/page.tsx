import type { Metadata } from "next";

import { AppsMarketplace } from "./apps-marketplace";

export const metadata: Metadata = {
  title: "Apps",
  description: "Connect the tools your team already uses.",
};

export default function AppsPage() {
  return (
    <AppsMarketplace />
  );
}
