import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { taskSounds } from "@/lib/task-sounds-player";
import { requestResend } from "./use-resend-run";

const originalFetch = globalThis.fetch;
const originalTaskSoundMoment = taskSounds.moment;
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
let keys: Array<string | null> = [];
let respond: () => Promise<Response>;

beforeEach(() => {
  keys = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  taskSounds.moment = async () => {};
  globalThis.fetch = (async (_input, init) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key"));
    return respond();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  taskSounds.moment = originalTaskSoundMoment;
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("requestResend", () => {
  test("an accepted click reports no error, and each click carries its own key", async () => {
    respond = async () => Response.json({ id: "run-2" }, { status: 201 });

    expect(await requestResend("run-1")).toBeNull();
    expect(await requestResend("run-1")).toBeNull();

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("a refusal shows the backend's reason", async () => {
    respond = async () =>
      Response.json(
        { error: "not_resendable", reason: "Commands can't be resent. Run the command again from the composer." },
        { status: 409 },
      );

    expect(await requestResend("run-1")).toBe(
      "Commands can't be resent. Run the command again from the composer.",
    );
  });

  test("a network failure falls back to a plain retry message", async () => {
    respond = async () => {
      throw new TypeError("network down");
    };

    expect(await requestResend("run-1")).toBe("Couldn't resend this message. Try again.");
  });
});
