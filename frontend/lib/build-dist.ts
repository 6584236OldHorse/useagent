/** The Next output directory. A production build or server always uses a directory
 *  separate from the dev server's `.next`, so neither can poison the other's Turbopack
 *  cache; `USEAGENT_BUILD_DIST` names an explicit one (a parallel stack, an audit build). */
export function resolveDistDir(production: boolean): string {
  if (process.env.USEAGENT_BUILD_DIST) return process.env.USEAGENT_BUILD_DIST;
  return production ? ".next-build" : ".next";
}
