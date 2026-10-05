import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { runnerToken } from "./security";

export type TokenEncryption = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend(): string;
};

function available(storage: TokenEncryption, platform: NodeJS.Platform): void {
  if (!storage.isEncryptionAvailable() || (platform === "linux" && storage.getSelectedStorageBackend() === "basic_text")) {
    throw new Error("Secure token storage is unavailable on this system.");
  }
}

export function createTokenStore(file: string, origin: string, storage: TokenEncryption, platform = process.platform) {
  return {
    async read(): Promise<string | undefined> {
      let encoded: string;
      try {
        encoded = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      available(storage, platform);
      if (encoded.length > 65_536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Stored runner token is invalid.");
      const value = JSON.parse(storage.decryptString(Buffer.from(encoded, "base64"))) as { origin?: unknown; token?: unknown };
      if (value.origin !== origin) return undefined;
      return runnerToken(value.token);
    },
    async write(token: string): Promise<void> {
      available(storage, platform);
      const encrypted = storage.encryptString(JSON.stringify({ origin, token: runnerToken(token) })).toString("base64");
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${dirname(file)}/.${basename(file)}.${process.pid}.${randomUUID()}`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(encrypted, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, file);
        await chmod(file, 0o600);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
    async remove(): Promise<void> {
      await unlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}
