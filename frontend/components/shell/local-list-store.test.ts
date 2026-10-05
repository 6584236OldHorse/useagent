import { describe, expect, test } from "bun:test";
import { appended, createLocalListStore, removed } from "./local-list-store";

describe("local list store", () => {
  test("appending keeps an existing id in place and drops the oldest past the cap", () => {
    expect(appended(["a", "b"], "c", 3)).toEqual(["a", "b", "c"]);
    expect(appended(["a", "b", "c"], "b", 3)).toEqual(["a", "b", "c"]);
    expect(appended(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
    expect(removed(["a", "b"], "a")).toEqual(["b"]);
    const same = ["a"];
    expect(removed(same, "zzz")).toBe(same);
  });

  test("reads a list per user and treats garbage as empty", () => {
    const store = createLocalListStore("useagent.test.list");
    const backing = new Map<string, string>([
      [store.storageKey("u1"), JSON.stringify(["r1", 7, "r2"])],
      [store.storageKey("u2"), "{not json"],
    ]);
    const storage = () => ({ getItem: (key: string) => backing.get(key) ?? null });
    expect(store.read(storage, "u1")).toEqual(["r1", "r2"]);
    expect(store.read(storage, "u2")).toEqual([]);
    expect(store.read(storage, null)).toEqual([]);
    expect(store.read(() => null, "u1")).toEqual([]);
    expect(store.storageKey(null)).toBe("useagent.test.list:anonymous");
  });
});
