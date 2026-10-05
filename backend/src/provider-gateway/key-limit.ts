/**
 * The plain reason when a model call was refused because the key behind it is
 * spent. OpenRouter answers 403 "Key limit exceeded" once a key's own spending
 * limit is used up; that text reaches us on the chat lane directly and through
 * a sandboxed engine's error. Null for any other error.
 */
export function providerKeyLimitReason(text: string): string | null {
  return /key limit exceeded/i.test(text)
    ? "The deployment's OpenRouter key has reached its spending limit, so the model refused this call. " +
        "Ask an admin to raise the key limit or add credit."
    : null;
}
