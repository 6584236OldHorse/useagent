/**
 * The plain reason when a model call was refused because the key behind it is
 * spent. OpenRouter answers 403 "Key limit exceeded" once a key's own spending
 * limit is used up; that text reaches us on the chat lane directly and through
 * a sandboxed engine's error. The key may be the deployment's or a member's
 * own connected one, and the failure text does not say which, so the wording
 * names neither. Null for any other error.
 */
export function providerKeyLimitReason(text: string): string | null {
  return /key limit exceeded/i.test(text)
    ? "The OpenRouter key that served this call has reached its spending limit, so the model refused it. " +
        "Raise that key's limit or add credit: your own connected key is yours to top up; the deployment's key is an admin's."
    : null;
}
