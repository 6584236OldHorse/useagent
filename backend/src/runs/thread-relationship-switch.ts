/** Thread relationships and product child threads are production behaviour; each has
 *  one kill switch and nothing else. The variables keep their historical names so a
 *  rollback to a release that still knows the staged modes reads the same lines
 *  (`on`) and behaves the same. */

/** `THREAD_RELATIONSHIPS_WRITE=off` stops writing and serving thread relationships. */
export function threadRelationshipsEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.THREAD_RELATIONSHIPS_WRITE?.trim().toLowerCase() !== "off";
}

/** Product child threads, and with them the child composer: messaging a child thread
 *  is part of the feature, never a separate switch. `PRODUCT_CHILD_THREADS=off` hides it. */
export function productChildThreadsEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.PRODUCT_CHILD_THREADS?.trim().toLowerCase() !== "off";
}

/** Boot check: the product feature cannot stay on while the relationships it renders
 *  are switched off. */
export function assertThreadRelationshipConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (productChildThreadsEnabled(env) && !threadRelationshipsEnabled(env)) {
    throw new Error("THREAD_RELATIONSHIPS_WRITE=off requires PRODUCT_CHILD_THREADS=off");
  }
}
