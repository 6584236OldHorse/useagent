/** Execution graph kill switch. The graph writer and its readers are production
 *  behaviour; `EXECUTION_GRAPH_ROLLOUT=off` is the only knob and it turns both off
 *  together. The variable keeps its historical name so a rollback to a release that
 *  still knows the staged modes reads the same line (`read`) and behaves the same. */
export function executionGraphEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.EXECUTION_GRAPH_ROLLOUT?.trim().toLowerCase() !== "off";
}
