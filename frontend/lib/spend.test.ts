import { describe, expect, test } from "bun:test";
import { parseSpend, scheduleSpendReads, spendLabel, spendLoader, type SpendSnapshot } from "./spend";

describe("spend loader", () => {
  test("only the newest request may report, so an older response never undoes a newer figure", async () => {
    const slow = Promise.withResolvers<SpendSnapshot | null>();
    const fast = Promise.withResolvers<SpendSnapshot | null>();
    const pending = [slow.promise, fast.promise];
    const reported: SpendSnapshot[] = [];
    const load = spendLoader(() => pending.shift()!, (spend) => reported.push(spend));

    const first = load(); // the mount read, slow
    const second = load(); // the settlement refresh, fast
    fast.resolve({ spent: 100, allowance: 100, runs: 4 });
    await second;
    slow.resolve({ spent: 95, allowance: 100, runs: 3 });
    await first;

    expect(reported).toEqual([{ spent: 100, allowance: 100, runs: 4 }]);
  });

  test("a failed or unusable response keeps the last good figure", async () => {
    const reported: SpendSnapshot[] = [];
    const answers: Array<() => Promise<SpendSnapshot | null>> = [
      () => Promise.resolve({ spent: 1, allowance: 100, runs: 1 }),
      () => Promise.reject(new Error("offline")),
      () => Promise.resolve(null),
    ];
    const load = spendLoader(() => answers.shift()!(), (spend) => reported.push(spend));
    await load();
    await load();
    await load();
    expect(reported).toEqual([{ spent: 1, allowance: 100, runs: 1 }]);
  });
});

describe("spend figures", () => {
  test("parses the backend shape and labels it", () => {
    expect(parseSpend({ spent: 12.345, allowance: 100, runs: 3 })).toEqual({ spent: 12.345, allowance: 100, runs: 3 });
    expect(parseSpend({ spent: 4, allowance: null })).toEqual({ spent: 4, allowance: null, runs: 0 });
    expect(parseSpend({ allowance: 100 })).toBeNull();
    expect(spendLabel({ spent: 12.345, allowance: 100, runs: 3 })).toBe("Spent $12.35 of $100");
    expect(spendLabel({ spent: 4, allowance: null, runs: 1 })).toBe("Spent $4.00");
  });
});

describe("spend reads per page", () => {
  function fakeTimers() {
    const pending = new Map<number, () => void>();
    let id = 0;
    return {
      host: {
        setTimeout: (fn: () => void) => {
          pending.set(++id, fn);
          return id;
        },
        clearTimeout: (handle: unknown) => {
          pending.delete(handle as number);
        },
      },
      /** Fire every pending timer (the grace elapsing). */
      elapse: () => {
        for (const fn of [...pending.values()]) fn();
        pending.clear();
      },
      pending: () => pending.size,
    };
  }

  test("the stream's open takes the first read and cancels the grace: one read per page", () => {
    const timers = fakeTimers();
    let reads = 0;
    const schedule = scheduleSpendReads(() => reads++, 1_500, timers.host);
    expect(reads).toBe(0);
    schedule.streamOpened();
    expect(reads).toBe(1);
    expect(timers.pending()).toBe(0);
    timers.elapse();
    expect(reads).toBe(1);
  });

  test("a slow stream: the grace reads, and the open that follows reads again", () => {
    const timers = fakeTimers();
    let reads = 0;
    const schedule = scheduleSpendReads(() => reads++, 1_500, timers.host);
    timers.elapse();
    expect(reads).toBe(1);
    schedule.streamOpened();
    expect(reads).toBe(2);
  });

  test("a reconnect reads again, and stop cancels a pending grace", () => {
    const timers = fakeTimers();
    let reads = 0;
    const schedule = scheduleSpendReads(() => reads++, 1_500, timers.host);
    schedule.streamOpened();
    schedule.streamOpened();
    expect(reads).toBe(2);
    const stopped = scheduleSpendReads(() => reads++, 1_500, timers.host);
    stopped.stop();
    timers.elapse();
    expect(reads).toBe(2);
  });
});
