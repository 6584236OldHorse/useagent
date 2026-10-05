import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Synchronous storage required by the Electron auth client. Values are already safeStorage-encrypted. */
export const authScope = (origin: string): string => createHash("sha256").update(origin).digest("hex");

export function createAuthStorage(file: string) {
  let values: Record<string, string> | undefined;
  const read = (): Record<string, string> => {
    if (values) return values;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || Object.values(parsed).some(value => typeof value !== "string")) throw new Error("Invalid desktop auth storage.");
      return values = parsed as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return values = {};
    }
  };
  return {
    getItem(name: string): string | null { return read()[name] ?? null; },
    setItem(name: string, value: unknown): void {
      if (typeof value !== "string") throw new Error("Invalid desktop auth storage value.");
      values = { ...read(), [name]: value };
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(values), { encoding: "utf8", mode: 0o600, flag: "wx" });
        renameSync(temporary, file);
        chmodSync(file, 0o600);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
    },
  };
}
