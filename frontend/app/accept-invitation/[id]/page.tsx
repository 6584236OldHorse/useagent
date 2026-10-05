import type { Metadata } from "next";
import { AcceptInvitation } from "./accept-invitation";

export const metadata: Metadata = { title: "Accept invitation" };

export default async function AcceptInvitationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AcceptInvitation id={id} />;
}
