import { createClerkClient } from "@clerk/backend";

export function identityClient() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error("Managed identity is not configured");
  return createClerkClient({ secretKey });
}
