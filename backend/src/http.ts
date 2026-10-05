/** Shared Hono environment: org-scoping middleware populates these per request. */
export type AppEnv = {
  Bindings: {
    /** Bun supplies the listening server as Hono's environment. Internal
     *  operator routes use its socket-level peer address and fail closed when
     *  the adapter cannot provide one. */
    requestIP?: (request: Request) => { address: string } | null;
  };
  Variables: {
    orgId: string;
    userId: string | null;
    // Set only by the API-key bearer lane (src/middleware/bearer.ts). Session
    // requests leave it undefined. Management routes assert it is NOT set so a
    // bearer key can never mint or revoke keys.
    bearerAuthenticated?: boolean;
    /** How the org middleware established the identity: a verified session, or
     *  the dev fallback (allowed only when ALLOW_DEV_ORG permits). Routes that
     *  must not treat the dev user as a person read this instead of resolving
     *  the session a second time. */
    identitySource?: "session" | "dev";
  };
};
