import { loadIdentityMethods } from "@/components/auth/identity-methods-config";

export async function GET(): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  try {
    return Response.json(await loadIdentityMethods(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY), {
      headers,
    });
  } catch {
    return Response.json({ error: "Sign-in methods are unavailable." }, { status: 503, headers });
  }
}
