/** What to tell the person when the server refuses the invitation. */
export function invitationProblem(status: number, message: string | null): string {
  const text = (message ?? "").toLowerCase();
  if (text.includes("not the recipient")) {
    return "This invitation was sent to a different email address. Sign in with the address that received it.";
  }
  if (text.includes("expired") || text.includes("not found") || status === 404) {
    return "This invitation has expired or was cancelled. Ask for a new one.";
  }
  if (text.includes("already a member")) return "You are already a member of this workspace.";
  if (status === 401) return "Sign in to accept this invitation.";
  if (status === 0) return "Could not reach useAgent. Check your connection and try again.";
  return message || "This invitation cannot be accepted right now.";
}
