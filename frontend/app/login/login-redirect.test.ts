import { expect, test } from "bun:test";
import LoginPage from "./[[...login]]/page";

test("login preserves internal redirects and rejects malformed or external normalization", async () => {
  for (const [redirect_url, callbackURL] of [
    ["/agent/new?desktop=1", "/agent/new?desktop=1"],
    ["/\\x//attacker.example", "/"],
    ["/\\[", "/"],
    ["/a/..//attacker.example", "/"],
  ]) {
    const page = await LoginPage({ searchParams: Promise.resolve({ redirect_url }) });
    expect(page.props).toMatchObject({ callbackURL });
  }
});
