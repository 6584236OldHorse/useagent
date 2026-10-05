/**
 * Isomorphic fetch to the useAgent backend (live on :3201).
 *
 * - Server: hit the backend origin directly (the Next `/api/*` rewrite only
 *   applies to browser requests) and forward the incoming request's `Cookie`
 *   header so the backend resolves the signed-in user's session/org during SSR
 *   instead of falling back to the dev org.
 * - Client: use a relative `/api/...` path so the rewrite proxies it, with
 *   `credentials:"include"` so the browser attaches the same-origin auth cookie.
 *
 * `next/headers` is imported lazily inside the server branch so this module is
 * safe to pull into the client bundle (the per-feature api layers that use it
 * are shared by client components).
 */
import { handleReleaseMismatch, withClientReleaseHeader } from "./release-compat";

const API_ORIGIN = process.env.USEAGENT_API_ORIGIN ?? "http://localhost:3201";

export async function backendFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (typeof window === "undefined") {
    const { cookies } = await import("next/headers");
    const cookieHeader = (await cookies()).toString();
    const headers = new Headers(init?.headers);
    if (cookieHeader) headers.set("cookie", cookieHeader);
    return fetch(`${API_ORIGIN}${path}`, { ...init, headers });
  }
  const browserInit = withClientReleaseHeader(path, init);
  const response = await fetch(path, { ...browserInit, credentials: "include" });
  handleReleaseMismatch(response, browserInit);
  return response;
}

/**
 * A browser upload with progress: the same credentials and release header as
 * `backendFetch`, over XMLHttpRequest because fetch reports no upload progress.
 * `onProgress` receives the share of bytes sent, 0 to 100.
 */
export function backendUpload(
  path: string,
  body: FormData,
  onProgress: (percent: number) => void,
): Promise<Response> {
  const init = withClientReleaseHeader(path, { method: "POST" });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    new Headers(init?.headers).forEach((value, name) => {
      xhr.setRequestHeader(name, value);
    });
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new Error(`upload failed (${path})`));
    xhr.onabort = xhr.onerror;
    xhr.onload = () => {
      const headers = new Headers();
      for (const line of xhr.getAllResponseHeaders().split(/\r?\n/)) {
        const at = line.indexOf(":");
        if (at > 0) headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
      }
      const response = new Response(xhr.status === 204 ? null : xhr.responseText, {
        status: xhr.status,
        headers,
      });
      try {
        handleReleaseMismatch(response, init);
      } catch (error) {
        reject(error);
        return;
      }
      resolve(response);
    };
    xhr.send(body);
  });
}
