import type { Metadata } from "next";
import { FirstRunSetup } from "./first-run-setup";

export const metadata: Metadata = {
  title: "Welcome",
  description: "Name your workspace and invite your team.",
};

export default function WelcomePage() {
  return <FirstRunSetup />;
}
