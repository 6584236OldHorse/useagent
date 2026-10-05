import type { Metadata } from "next";

import { ReviewWorkspace } from "./review-workspace";

export const metadata: Metadata = {
  title: "Pull requests - useAgent",
  description: "Open pull requests across your connected GitHub repositories.",
};

export default function ReviewPage() {
  return (
    <ReviewWorkspace />
  );
}
