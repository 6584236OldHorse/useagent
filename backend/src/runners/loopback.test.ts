import { describe, expect, test } from "bun:test";
import type { MuxStream } from "@useagent/runner-protocol";
import { FORWARDER_IDLE_MS, LoopbackForwarders } from "./loopback";

const never = () => new Promise<MuxStream>(() => {});

describe("loopback forwarders", () => {
  test("one listener per sandbox port, bounded per machine, released by sandbox", () => {
    const forwarders = new LoopbackForwarders({ max: 2 });
    const a = forwarders.address("c1", 80, never);
    expect(forwarders.address("c1", 80, never)).toBe(a);
    forwarders.address("c1", 81, never);
    expect(forwarders.size).toBe(2);
    expect(() => forwarders.address("c2", 80, never)).toThrow(/preview ports/);
    forwarders.release("c1");
    expect(forwarders.size).toBe(0);
    forwarders.address("c2", 80, never);
    forwarders.closeAll();
    expect(forwarders.size).toBe(0);
  });

  test("idle listeners are swept and make room", () => {
    let now = 1_000_000;
    const forwarders = new LoopbackForwarders({ max: 1, now: () => now });
    forwarders.address("c1", 80, never);
    expect(() => forwarders.address("c1", 81, never)).toThrow(/preview ports/);
    now += FORWARDER_IDLE_MS;
    expect(forwarders.sweep()).toBe(1);
    forwarders.address("c1", 81, never);
    expect(forwarders.size).toBe(1);
    forwarders.closeAll();
  });

  test("a stream that cannot be opened ends the browser connection", async () => {
    const forwarders = new LoopbackForwarders();
    const address = forwarders.address("c1", 80, () => {
      throw new Error("runner is away");
    });
    await expect(fetch(`http://${address.host}:${address.port}/`)).rejects.toThrow();
    forwarders.closeAll();
  });
});
