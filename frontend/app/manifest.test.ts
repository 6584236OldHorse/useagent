import { describe, expect, test } from "bun:test";
import manifest from "./manifest";

describe("web app manifest", () => {
  test("includes app metadata and installable icon set", async () => {
    const result = await manifest();

    expect(result.name).toBe("useAgent");
    expect(result.short_name).toBe("useAgent");
    expect(result.start_url).toBe("/");
    expect(result.display).toBe("standalone");
    expect(result.background_color).toBe("#0d1117");
    expect(result.theme_color).toBe("#0d1117");
    expect(result.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          src: "/manifest-icon-192.svg",
          sizes: "192x192",
          type: "image/svg+xml",
          purpose: "any",
        }),
        expect.objectContaining({
          src: "/manifest-icon-512.svg",
          sizes: "512x512",
          type: "image/svg+xml",
          purpose: "any",
        }),
        expect.objectContaining({
          src: "/maskable-icon.svg",
          sizes: "512x512",
          type: "image/svg+xml",
          purpose: "maskable",
        }),
      ]),
    );
  });
});
