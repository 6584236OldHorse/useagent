/** Resolve a website URL to its conventional root favicon location; null when
 *  the value is not an absolute http(s) URL. */
export function getFaviconUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return new URL("/favicon.ico", url).toString();
  } catch {
    return null;
  }
}
