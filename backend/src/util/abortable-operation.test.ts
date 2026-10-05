import { describe, expect, test } from "bun:test";
import { awaitWithSignal } from "./abortable-operation";

describe("awaitWithSignal", () => {
  test("does not start an operation after cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    let started = false;

    await expect(awaitWithSignal(async () => {
      started = true;
    }, controller.signal)).rejects.toThrow("cancelled");
    expect(started).toBe(false);
  });

  test("stops waiting without leaving a late rejection unhandled", async () => {
    const controller = new AbortController();
    let rejectOperation!: (error: Error) => void;
    const pending = awaitWithSignal(
      () => new Promise<void>((_, reject) => { rejectOperation = reject; }),
      controller.signal,
    );

    controller.abort(new Error("deadline"));
    await expect(pending).rejects.toThrow("deadline");
    rejectOperation(new Error("late failure"));
    await Bun.sleep(0);
  });
});
