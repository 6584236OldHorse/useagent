/**
 * One shared request per browser page: concurrent callers await the same
 * promise, later callers reuse the settled value until `ttlMs` passes, and a
 * failed request is not kept. The server never shares (a module-level cache
 * there would cross requests and users), so a caller outside the browser gets
 * a fresh load every time.
 */
export interface CachedRequest<T> {
  /** The shared request; `fresh` skips whatever is cached and replaces it. */
  get(fresh?: boolean): Promise<T>;
  /** The last settled value, when there is one the next `get` would reuse. */
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
  let entry: { promise: Promise<T>; at: number; value?: { current: T } } | null = null;
  return {
    get(fresh = false) {
      if (!isShared()) return load();
      const now = Date.now();
      if (!fresh && entry && now - entry.at < ttlMs) return entry.promise;
      const next: NonNullable<typeof entry> = { promise: load(), at: now };
      entry = next;
      next.promise.then(
        (value) => {
          if (entry === next) next.value = { current: value };
        },
        () => {
          if (entry === next) entry = null;
        },
      );
      return next.promise;
    },
    peek() {
      if (!entry?.value || Date.now() - entry.at >= ttlMs) return undefined;
      return entry.value.current;
    },
    invalidate() {
      entry = null;
    },
  };
}
