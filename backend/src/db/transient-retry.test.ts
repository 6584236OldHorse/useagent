import { expect, spyOn, test } from "bun:test";
import { withTransientDbRetry } from "./transient-retry";

const transient = () => Object.assign(new Error("Failed query"), { cause: { code: "40P01" } });

test("retries a transient database failure, never any other, and gives up after its budget", async () => {
  const warned = spyOn(console, "warn").mockImplementation(() => {});
  try {
    let calls = 0;
    expect(await withTransientDbRetry("op", async () => {
      calls += 1;
      if (calls < 3) throw transient();
      return "ok";
    }, [0, 0, 0])).toBe("ok");
    expect(calls).toBe(3);

    calls = 0;
    await expect(withTransientDbRetry("op", async () => {
      calls += 1;
      throw new Error("constraint violated");
    }, [0, 0])).rejects.toThrow("constraint violated");
    expect(calls).toBe(1);

    calls = 0;
    await expect(withTransientDbRetry("op", async () => {
      calls += 1;
      throw Object.assign(new Error("socket closed"), { code: "CONNECTION_CLOSED" });
    }, [0, 0])).rejects.toThrow("socket closed");
    expect(calls).toBe(3);
  } finally {
    warned.mockRestore();
  }
});
