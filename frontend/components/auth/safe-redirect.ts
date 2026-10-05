/** The path a sign-in returns to. Anything that is not a plain path on this site, or that the URL parser rejects, becomes the root. */
export function safeAuthRedirect(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const sentinel = "https://useagent.invalid";
    const url = new URL(value, sentinel);
    if (url.origin !== sentinel) return "/";
    const path = `${url.pathname}${url.search}${url.hash}`;
    return path.startsWith("/") && !path.startsWith("//") ? path : "/";
  } catch {
    return "/";
  }
}
