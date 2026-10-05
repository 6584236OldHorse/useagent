import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { InMemoryArtifactStorage } from "../../test/in-memory-artifact-storage";
import { setArtifactStorageForTest } from "./storage";
import { ensureStoredArtifactBytes, verifyStoredArtifactBytes } from "./storage-integrity";

afterEach(() => setArtifactStorageForTest(null));

describe("artifact storage integrity", () => {
  test("restores missing bytes and rejects same-size corruption", async () => {
    const storage = new InMemoryArtifactStorage();
    setArtifactStorageForTest(storage);
    const bytes = Buffer.from("valid");
    const digest = createHash("sha256").update(bytes).digest("hex");

    await ensureStoredArtifactBytes(digest, bytes);
    await expect(verifyStoredArtifactBytes(digest, bytes.byteLength)).resolves.toBeUndefined();

    storage.values.set(digest, Buffer.from("wrong"));
    await expect(verifyStoredArtifactBytes(digest, bytes.byteLength)).rejects.toThrow(
      "artifact storage verification failed",
    );
  });
});
