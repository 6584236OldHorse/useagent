import { markGatewayProviderApiKeyRejected } from "./api-key-credentials";
import { PROVIDER_DISPLAY_NAMES, PROVIDER_IDS, type ProviderId } from "./provider";
import { responseBodyPrefix } from "./retry";

/** A 403 body that names a bad key. Spend limits ("Key limit exceeded"),
 *  credits, policy and region refusals do not match. */
const REJECTED_KEY_403 =
  /\b(?:invalid|expired|revoked|disabled)\b[^.]{0,40}\bkey\b|\bkey\b[^.]{0,40}\b(?:invalid|expired|revoked|disabled)\b/i;

/** True when the provider refused the key itself (expired, revoked or
 *  invalid): any 401, or a 403 whose body names a bad key. A 5xx, a network
 *  error, credits, limits and rate limits are never a rejected key. */
export function providerRejectedKey(status: number, bodyPrefix = ""): boolean {
  return status === 401 || (status === 403 && REJECTED_KEY_403.test(bodyPrefix));
}

/** What a turn failed by a rejected member key records. */
export function providerKeyRejectedFailure(
  provider: ProviderId,
): { readonly label: string; readonly reason: string } {
  const name = PROVIDER_DISPLAY_NAMES[provider];
  return {
    label: `${name} key rejected`,
    reason: `Your ${name} key was rejected (expired or revoked). Reconnect it in Settings.`,
  };
}

/** The remedy an engine relayed from the gateway's rejected-key answer; null
 *  for any other error text. */
export function relayedKeyRejectedFailure(
  text: string,
): { readonly label: string; readonly reason: string } | null {
  return PROVIDER_IDS.map(providerKeyRejectedFailure).find((failure) => text.includes(failure.reason)) ?? null;
}

/** A member's key the provider rejected; the connection is already marked. */
export class ProviderKeyRejectedError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly status: number,
  ) {
    super(providerKeyRejectedFailure(provider).reason);
    this.name = "ProviderKeyRejectedError";
  }
}

/** The gateway's answer when the provider rejected a member's key: the
 *  connection is marked reauth_required and the provider's body is replaced by
 *  the remedy, so neither the sandbox nor the run keeps the provider's text.
 *  Null for any other upstream answer, which passes through untouched. */
export async function rejectedMemberKeyResponse(
  upstream: Response,
  key: {
    readonly orgId: string;
    readonly userId: string;
    readonly provider: ProviderId;
    readonly value: string;
  },
  mark: typeof markGatewayProviderApiKeyRejected = markGatewayProviderApiKeyRejected,
): Promise<Response | null> {
  if (upstream.status !== 401 && upstream.status !== 403) return null;
  const prefix = upstream.status === 403 ? await responseBodyPrefix(upstream) : "";
  if (!providerRejectedKey(upstream.status, prefix)) return null;
  await upstream.body?.cancel().catch(() => undefined);
  await mark({ ...key, status: upstream.status });
  return Response.json(
    {
      type: "error",
      error: { type: "authentication_error", message: providerKeyRejectedFailure(key.provider).reason },
    },
    { status: upstream.status, headers: { "x-should-retry": "false" } },
  );
}
