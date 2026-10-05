/**
 * The name a person's own workspace is created with. auth-hooks.ts
 * createPersonalOrgForUser writes the same string, and team-workspaces.test.ts
 * holds the two together. A workspace that still carries it, with its creator
 * as the only member, is on its first run (the /welcome page).
 */
export function personalWorkspaceName(user: { name?: string | null; email: string }): string {
  const label = (user.name?.trim() || user.email.split("@")[0] || "workspace").trim();
  return `${label}'s workspace`;
}
