"use client";

// Browser auth helpers. The backend owns the local user identity and active
// organization returned by `/api/auth/get-session`.

import { useCallback, useEffect, useState } from "react";
import { invalidateCapabilityCatalog } from "@/hooks/use-capability-catalog";
import { backendFetch } from "./backend-fetch";
import { type CachedRequest, cachedRequest } from "./cached-request";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface Session {
  user: SessionUser;
  session: { activeOrganizationId?: string | null };
}

export interface Organization {
  id: string;
  name: string;
}

/** How long a page reuses one session answer across the components that read
 *  it; a session that expires or changes server-side is seen again within this. */
export const SESSION_TTL_MS = 60_000;

/** Anonymous is an answer (null); a failed request throws so it is never kept. */
async function fetchSession(fetcher: typeof backendFetch): Promise<Session | null> {
  const res = await fetcher("/api/auth/get-session");
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`get-session failed: ${res.status}`);
  const data = (await res.json()) as Partial<Session> | null;
  return data?.user ? { user: data.user, session: data.session ?? {} } : null;
}

/** One session request per page, shared by every `useSession` consumer. */
export function createSessionRequest(
  fetcher: typeof backendFetch = backendFetch,
  options: { readonly isShared?: () => boolean; readonly ttlMs?: number } = {},
): CachedRequest<Session | null> {
  return cachedRequest(() => fetchSession(fetcher), { ttlMs: SESSION_TTL_MS, ...options });
}

const sessionRequest = createSessionRequest();
const sessionListeners = new Set<() => void>();

/** The authenticated session, or null when anonymous (incl. the dev-org path,
 *  where domain APIs still work but no better-auth session cookie exists) and
 *  when the request failed; a failure is not cached. */
export async function getSession(): Promise<Session | null> {
  try {
    return await sessionRequest.get();
  } catch {
    return null;
  }
}

/** The account may have changed: forget the cached session and every other
 *  cache scoped to the actor (the capability catalog carries the actor's
 *  provider connections), so the next reads ask the backend again. */
export function invalidateSession(): void {
  sessionRequest.invalidate();
  invalidateCapabilityCatalog();
  for (const listener of sessionListeners) listener();
}

/** Begin the Google OAuth flow: better-auth returns the provider URL to visit,
 *  and we hand the browser off to it. Throws if Google isn't configured. */
export async function signInWithGoogle(callbackURL = "/"): Promise<void> {
  const res = await backendFetch("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "google", callbackURL }),
  });
  if (!res.ok) throw new Error(`Google sign-in unavailable (${res.status})`);
  const data = (await res.json()) as { url?: string };
  if (!data.url) throw new Error("No redirect URL returned");
  window.location.href = data.url;
}

/** End the session (clears the cookie server-side). */
export async function signOut(): Promise<void> {
  const res = await backendFetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`Sign-out failed (${res.status})`);
  invalidateSession();
}

export async function listOrganizations(
  fetcher: typeof backendFetch = backendFetch,
): Promise<Organization[]> {
  const res = await fetcher("/api/auth/organization/list", { cache: "no-store" });
  if (!res.ok) throw new Error(`Workspace list failed (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("Workspace list returned an invalid response");
  return data as Organization[];
}

export async function switchOrganization(
  organizationId: string,
  fetcher: typeof backendFetch = backendFetch,
  reload: () => void = () => window.location.replace("/"),
  invalidate: () => void = invalidateSession,
): Promise<void> {
  try {
    const res = await fetcher("/api/auth/organization/set-active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId }),
    });
    if (!res.ok) throw new Error(`Workspace switch failed (${res.status})`);
  } finally {
    invalidate();
    reload();
  }
}

export interface AuthConfig {
  /** Google provider configured (GOOGLE_CLIENT_ID/SECRET both present). */
  google: boolean;
  emailPassword: boolean;
  /** Unauthenticated dev-org access currently open (ALLOW_DEV_ORG). */
  allowDevOrg: boolean;
}

const FALLBACK_CONFIG: AuthConfig = {
  google: false,
  emailPassword: false,
  allowDevOrg: false,
};

/** Public auth config. It never carries any secret. */
export async function getAuthConfig(
  fetcher: typeof backendFetch = backendFetch,
): Promise<AuthConfig> {
  try {
    const res = await fetcher("/api/auth/provider-config");
    if (!res.ok) return FALLBACK_CONFIG;
    const data = (await res.json()) as Partial<AuthConfig>;
    return {
      google: Boolean(data.google),
      emailPassword: data.emailPassword === true,
      allowDevOrg: Boolean(data.allowDevOrg),
    };
  } catch {
    return FALLBACK_CONFIG;
  }
}

/** Subscribe to the current session; `refresh()` re-fetches (e.g. after sign-out).
 *  Every consumer on a page shares one request; a consumer mounting after it
 *  settled starts from the cached session instead of a loading state. */
type SessionState = {
  session: Session | null;
  loading: boolean;
  refresh: () => void;
};

function useBackendSession(): SessionState {
  const cached = sessionRequest.peek();
  const [session, setSession] = useState<Session | null>(cached ?? null);
  const [loading, setLoading] = useState(cached === undefined);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(invalidateSession, []);

  useEffect(() => {
    const listener = () => setNonce((n) => n + 1);
    sessionListeners.add(listener);
    return () => {
      sessionListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getSession().then((s) => {
      if (cancelled) return;
      setSession(s);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { session, loading, refresh };
}

/** Backend-normalized local user session. */
export function useSession(): SessionState {
  return useBackendSession();
}

/** The public auth config, fetched once on mount. Null until it resolves. */
export function useAuthConfig(): AuthConfig | null {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    getAuthConfig().then((c) => {
      if (!cancelled) setConfig(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return config;
}
