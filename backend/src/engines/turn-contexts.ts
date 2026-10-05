import { type ResourceAccessSnapshot, formatResourceAccessContext } from "../resources/access-snapshot";
import { type SkillCatalogPage, frameSkillCatalogContext } from "../skills/catalog";
import { MEMORY_UNAVAILABLE_NOTE } from "../memory/memory-skill-text";

/**
 * The per-turn reference contexts the worker hands every engine, framed once:
 * the owning bot's assignment (bot-owned threads only) followed by recalled
 * memory, the org's skill catalog page, and the resource access snapshot. Each
 * is "" when there is nothing to say.
 */
export function frameTurnContexts(input: {
  readonly recall: { readonly rendered?: string; readonly degraded?: boolean } | null | undefined;
  readonly skillCatalogPage: Pick<SkillCatalogPage, "skills" | "nextCursor"> | null | undefined;
  readonly resourceSnapshot: ResourceAccessSnapshot | null | undefined;
  readonly botIdentity?: string;
}): { turnContext: string; skillCatalogContext: string; resourceContext: string } {
  return {
    turnContext: (input.botIdentity ?? "") + (input.recall?.degraded ? MEMORY_UNAVAILABLE_NOTE : "") + (input.recall?.rendered ?? ""),
    skillCatalogContext: input.skillCatalogPage ? frameSkillCatalogContext(input.skillCatalogPage) : "",
    resourceContext: input.resourceSnapshot ? formatResourceAccessContext(input.resourceSnapshot) : "",
  };
}
