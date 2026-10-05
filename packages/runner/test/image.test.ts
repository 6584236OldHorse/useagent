import { expect, test } from "bun:test";
import { ensureImage } from "../src/image";
import { FakeBackend } from "./fake-backend";

const DIGEST = "sha256:" + "1".repeat(64);
const pull = { registry: "ghcr.io", username: "x", password: "pull-token" };

test("an image already present at its digest needs no pull and no login", async () => {
  const backend = new FakeBackend();
  backend.images.set("ghcr.io/useagenthq/sandbox:one", DIGEST);
  expect(await ensureImage(backend, { ref: "ghcr.io/useagenthq/sandbox:one", digest: DIGEST, pull })).toBe(DIGEST);
  expect(backend.calls).toEqual([]);
});

test("a private image is pulled inside a login that ends with the pull", async () => {
  const backend = new FakeBackend();
  backend.pullYields.set("ghcr.io/useagenthq/sandbox:one", DIGEST);
  expect(await ensureImage(backend, { ref: "ghcr.io/useagenthq/sandbox:one", digest: DIGEST, pull })).toBe(DIGEST);
  expect(backend.calls).toEqual(["login ghcr.io x pull-token", "pull ghcr.io/useagenthq/sandbox:one", "logout ghcr.io"]);
});

test("a failed pull still logs out and reports the engine's reason", async () => {
  const backend = new FakeBackend();
  backend.pullFails = "container image pull ghcr.io/useagenthq/sandbox:one failed: unauthorized";
  await expect(ensureImage(backend, { ref: "ghcr.io/useagenthq/sandbox:one", digest: DIGEST, pull })).rejects.toThrow("unauthorized");
  expect(backend.calls).toEqual(["login ghcr.io x pull-token", "logout ghcr.io"]);
});

test("a public image is pulled without any login", async () => {
  const backend = new FakeBackend();
  backend.pullYields.set("ghcr.io/useagenthq/sandbox:one", DIGEST);
  await ensureImage(backend, { ref: "ghcr.io/useagenthq/sandbox:one", digest: DIGEST });
  expect(backend.calls).toEqual(["pull ghcr.io/useagenthq/sandbox:one"]);
});
