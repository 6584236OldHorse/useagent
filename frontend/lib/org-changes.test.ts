import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// The shared org stream: a fake EventSource stands in for the browser's, and the
// module is imported fresh per test so its page-wide state starts empty.
type Handler = (event: unknown) => void;
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly handlers = new Map<string, Handler[]>();
  closed = false;
  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, handler: Handler): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }
  fire(type: string): void {
    for (const handler of this.handlers.get(type) ?? []) handler({});
  }
  close(): void {
    this.closed = true;
  }
}

const globals = globalThis as unknown as { window?: unknown; EventSource?: unknown };
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("the org stream tells a late subscriber it is open", () => {
  let subscribeOrgChanges: typeof import("./org-changes").subscribeOrgChanges;
  beforeEach(async () => {
    FakeEventSource.instances = [];
    globals.window = globalThis;
    globals.EventSource = FakeEventSource;
    subscribeOrgChanges = (await import(`./org-changes?${Math.random()}`)).subscribeOrgChanges;
  });
  afterEach(() => {
    delete globals.window;
    delete globals.EventSource;
  });

  test("a subscriber that joins an open stream hears open once, without a second open on the wire", async () => {
    let first = 0;
    let late = 0;
    const offFirst = subscribeOrgChanges(() => undefined, () => first++);
    const source = FakeEventSource.instances[0];
    expect(source).toBeDefined();
    source?.fire("open");
    expect(first).toBe(1);
    const offLate = subscribeOrgChanges(() => undefined, () => late++);
    await flush();
    expect(late).toBe(1);
    expect(first).toBe(1);
    offLate();
    offFirst();
  });

  test("a subscriber that joins while the stream reconnects hears only the open that follows", async () => {
    let late = 0;
    const offFirst = subscribeOrgChanges(() => undefined);
    const source = FakeEventSource.instances[0];
    source?.fire("open");
    source?.fire("error");
    const offLate = subscribeOrgChanges(() => undefined, () => late++);
    await flush();
    expect(late).toBe(0);
    source?.fire("open");
    expect(late).toBe(1);
    offLate();
    offFirst();
  });

  test("a subscriber that unsubscribes before the microtask is not called", async () => {
    let late = 0;
    const offFirst = subscribeOrgChanges(() => undefined);
    FakeEventSource.instances[0]?.fire("open");
    const offLate = subscribeOrgChanges(() => undefined, () => late++);
    offLate();
    await flush();
    expect(late).toBe(0);
    offFirst();
  });
});
