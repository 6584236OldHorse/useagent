/**
 * One shared request per browser page: callers join a pending request, later
 * callers reuse the settled value until `ttlMs` after it settled, and a
 * failed request is not kept. `invalidate` forgets the value and detaches a
 * pending request so its late result is not kept either. The server never
 * shares (a module-level cache there would cross requests and users), so a
 * caller outside the browser gets a fresh load every time.
 */
export interface CachedRequest<T> {
  /** The shared request; `fresh` skips a settled value (a pending request is joined). */
  get(fresh?: boolean): Promise<T>;
  /** The settled value the next `get` would reuse: nothing while a request is pending. */
  peek(): T | undefined;
  invalidate(): void;
}

export function cachedRequest<T>(
  load: () => Promise<T>,
  options: {
    readonly ttlMs?: number;
    /** Overridable for tests, which run without a window. */
    readonly isShared?: () => boolean;
  } = {},
): CachedRequest<T> {
  const ttlMs = options.ttlMs ?? Number.POSITIVE_INFINITY;
  const isShared = options.isShared ?? (() => typeof window !== "undefined");
  let pending: Promise<T> | null = null;
  let settled: { value: T; at: number } | null = null;
  const current = (): T | undefined =>
    !pending && settled && Date.now() - settled.at < ttlMs ? settled.value : undefined;
  return {
    get(fresh = false) {
      if (!isShared()) return load();
      if (pending) return pending;
      if (!fresh) {
        const value = current();
        if (value !== undefined) return Promise.resolve(value);
      }
      const request = load();
      pending = request;
      request.then(
        (value) => {
          if (pending !== request) return;
          pending = null;
          settled = { value, at: Date.now() };
        },
        () => {
          if (pending === request) pending = null;
        },
      );
      return request;
    },
    peek: current,
    invalidate() {
      settled = null;
      pending = null;
    },
  };
}
