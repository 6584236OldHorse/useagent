import { expect, test } from "bun:test";
import { jumpToEnd } from "./scroll-to-end-pill";

test("scroll-to-end jumps synchronously without starting an interruptible smooth scroll", () => {
  let scrollToCalls = 0;
  const element = {
    scrollTop: 508,
    scrollHeight: 531,
    scrollTo: () => scrollToCalls++,
  };

  jumpToEnd(element);

  expect(element.scrollTop).toBe(531);
  expect(scrollToCalls).toBe(0);
});
