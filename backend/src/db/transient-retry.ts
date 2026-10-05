import { errorMessage } from "../util/error-message";
import { isTransientDbError } from "./pg-errors";

/** Waits before each retry. Bounded: a sustained outage still reaches the
 *  caller after about five seconds. */
const RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 4_000];

/** Run `operation`, repeating it while it fails with a transient database
 *  error. `operation` must be safe to repeat; any other error, and the last
 *  transient one, is thrown to the caller. */
export async function withTransientDbRetry<T>(
  label: string,
  operation: () => Promise<T>,
  delaysMs: readonly number[] = RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = delaysMs[attempt];
      if (delay === undefined || !isTransientDbError(error)) throw error;
      console.warn(`[db] ${label} failed transiently; retry ${attempt + 1} in ${delay}ms:`, errorMessage(error));
      await Bun.sleep(delay);
    }
  }
}
