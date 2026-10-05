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

  test("aborting a delayed put stops waiting and leaves only late content bytes", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    class DelayedStorage extends InMemoryArtifactStorage {
      override async put(key: string, bytes: Uint8Array): Promise<void> {
        markStarted();
        await released;
        return super.put(key, bytes);
      }
    }
    const storage = new DelayedStorage();
    setArtifactStorageForTest(storage);
    const bytes = Buffer.from("late bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const controller = new AbortController();
    const pending = ensureStoredArtifactBytes(digest, bytes, controller.signal);
    await started;

    controller.abort(new Error("deadline"));
    await expect(pending).rejects.toThrow("deadline");
    release();
    await Bun.sleep(0);
    expect(storage.values.get(digest)).toEqual(bytes);
  });
});
