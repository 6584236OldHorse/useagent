import { expect, test } from "bun:test";
import { keyedSerial } from "./keyed-serial";

test("same key runs in order, different keys overlap, a failure does not block the key", async () => {
  const serial = keyedSerial();
  const log: string[] = [];
  const gate = Promise.withResolvers<void>();
  const a1 = serial("a", async () => {
    log.push("a1 start");
    await gate.promise;
    log.push("a1 end");
  });
  const a2 = serial("a", async () => {
    log.push("a2");
  });
  const b1 = serial("b", async () => {
    log.push("b1");
  });
  await b1;
  expect(log).toEqual(["a1 start", "b1"]);
  gate.resolve();
  await Promise.all([a1, a2]);
  expect(log).toEqual(["a1 start", "b1", "a1 end", "a2"]);
  await expect(serial("a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(await serial("a", async () => "after")).toBe("after");
});
