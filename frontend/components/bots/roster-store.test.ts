import { expect, test } from "bun:test";
import { publishRoster, publishedRoster, subscribeRoster } from "./roster-store";
import type { ApiBot } from "./types";

const bot = (id: string) => ({ id, name: id }) as ApiBot;

test("a published roster reaches subscribers and is kept for late readers", () => {
  const seen: string[][] = [];
  const unsubscribe = subscribeRoster((bots) => seen.push(bots.map((b) => b.id)));
  publishRoster([bot("a"), bot("b")]);
  expect(seen).toEqual([["a", "b"]]);
  expect(publishedRoster()?.map((b) => b.id)).toEqual(["a", "b"]);
  unsubscribe();
  publishRoster([bot("c")]);
  expect(seen).toEqual([["a", "b"]]);
});
