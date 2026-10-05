/** Warm every signed-in route's JavaScript once the first page is idle, so a hop
 *  to any page finds its code in the browser cache. Data is never fetched here:
 *  the router prefetch owns layouts and loading states, this owns bytes. */

export type Connection = { saveData?: boolean; effectiveType?: string } | undefined;

/** The chunk URLs the page has not loaded, in the order given. */
export function chunksToWarm(chunks: readonly string[], loaded: Iterable<string>): string[] {
  const present = new Set<string>();
  for (const src of loaded) {
    try {
      present.add(new URL(src, "http://localhost").pathname);
    } catch {
      // not a URL; nothing to skip
    }
  }
  return chunks.filter((chunk) => !present.has(chunk));
}

/** Whether the bytes are worth spending on this connection. */
export function shouldWarm(connection: Connection): boolean {
  if (!connection) return true;
  if (connection.saveData) return false;
  return !/^(slow-2g|2g|3g)$/.test(connection.effectiveType ?? "");
}

export type WarmOptions = {
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** Script URLs already on the page. */
  loaded?: () => Iterable<string>;
  connection?: Connection;
  concurrency?: number;
};

/** Returns how many chunks were requested; zero when nothing needed warming. */
export async function warmRouteChunks(options: WarmOptions = {}): Promise<number> {
  if (!shouldWarm(options.connection)) return 0;
  const fetchImpl = options.fetchImpl ?? fetch;
  const storage = options.storage === undefined ? safeSessionStorage() : options.storage;
  const response = await fetchImpl("/route-chunks");
  if (!response.ok) return 0;
  const { buildId, chunks } = (await response.json()) as { buildId: string; chunks: string[] };
  const key = `route-chunks:${buildId}`;
  if (storage?.getItem(key)) return 0;
  const loaded = options.loaded?.() ?? Array.from(document.scripts, (script) => script.src).filter(Boolean);
  const queue = chunksToWarm(chunks, loaded);
  const requested = queue.length;
  const workers = Array.from({ length: Math.max(1, options.concurrency ?? 3) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      // A plain fetch fills the HTTP cache; the immutable chunk is served from it
      // on the hop. The body is read to the end: fetch resolves on headers, and a
      // download only counts once the bytes have landed.
      try {
        const response = await fetchImpl(next, { priority: "low" } as RequestInit);
        await response.arrayBuffer();
      } catch {
        // a missing chunk is not this page's problem; the hop fetches it itself
      }
    }
  });
  await Promise.all(workers);
  storage?.setItem(key, "1");
  return requested;
}

function safeSessionStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
