import { expect, test } from "bun:test";
import { ensureImage } from "../src/image";
import { FakeBackend } from "./fake-backend";

const DIGEST = "sha256:" + "1".repeat(64);
const REF = "app.useagent.org/useagenthq/sandbox:one";

test("an image already present at its digest needs no pull", async () => {
  const backend = new FakeBackend();
  backend.images.set(REF, DIGEST);
  expect(await ensureImage(backend, { ref: REF, digest: DIGEST, pull: { registry: "app.useagent.org", username: "runner", password: "rt" } })).toBe(DIGEST);
  expect(backend.calls).toEqual([]);
});

test("a login with a password is handed to the engine for the pull", async () => {
  const backend = new FakeBackend();
  backend.pullYields.set(REF, DIGEST);
  expect(await ensureImage(backend, { ref: REF, digest: DIGEST, pull: { registry: "app.useagent.org", username: "runner", password: "rt" } })).toBe(DIGEST);
  expect(backend.calls).toEqual([`pull ${REF} as runner@app.useagent.org`]);
  expect(backend.passwords).toEqual(["rt"]);
});

test("a login without a password is not presented (the caller fills the runner token first)", async () => {
  const backend = new FakeBackend();
  backend.pullYields.set(REF, DIGEST);
  await ensureImage(backend, { ref: REF, digest: DIGEST, pull: { registry: "app.useagent.org", username: "runner" } });
  expect(backend.calls).toEqual([`pull ${REF}`]);
});

test("a failed pull reports the engine's reason", async () => {
  const backend = new FakeBackend();
  backend.pullFails = `container image pull ${REF} failed: unauthorized`;
  await expect(ensureImage(backend, { ref: REF, digest: DIGEST })).rejects.toThrow("unauthorized");
});

test("a digest mismatch after the pull is an error", async () => {
  const backend = new FakeBackend();
  backend.pullYields.set(REF, "sha256:" + "2".repeat(64));
  await expect(ensureImage(backend, { ref: REF, digest: DIGEST })).rejects.toThrow("expects");
});
