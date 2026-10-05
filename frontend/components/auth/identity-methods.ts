"use client";

import { useEffect, useState } from "react";
import { type IdentityMethods, NO_IDENTITY_METHODS } from "./identity-methods-config";

export function useIdentityMethods(): IdentityMethods & { loading: boolean; error: string | null } {
  const [state, setState] = useState({
    ...NO_IDENTITY_METHODS,
    loading: true,
    error: null as string | null,
  });
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/login/methods", {
          cache: "no-store",
          credentials: "omit",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
        });
        if (!response.ok) throw new Error("Sign-in methods are unavailable.");
        const methods = (await response.json()) as IdentityMethods;
        if (!controller.signal.aborted) setState({ ...methods, loading: false, error: null });
      } catch {
        if (!controller.signal.aborted) {
          setState({
            ...NO_IDENTITY_METHODS,
            loading: false,
            error: "Sign-in methods are unavailable. Please reload and try again.",
          });
        }
      }
    })();
    return () => controller.abort();
  }, []);
  return state;
}
