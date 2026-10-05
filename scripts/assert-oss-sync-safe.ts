/** Private Pro paths that must never enter the public OSS repository: the
 * production host lane, prod Terraform, internal planning notes, the
 * workflows plus controller that drive the production promote, and the
 * licensed BoardUI Pro components (tag `boardui-pro-begins` marks the first
 * commit that uses them; the public replay stops before it). */
export const OSS_SYNC_EXCLUDED_PREFIXES = [
  "frontend/components/pro/",
  "deploy/hetzner/",
  "infra/terraform/prod/",
  "plan/",
  ".github/workflows/promote.yml",
  ".github/workflows/gates.yml",
  ".github/workflows/images.yml",
  "deploy/promote.ts",
] as const;

export function assertOssSyncSafe(paths: readonly string[]): void {
  const privatePaths = paths.filter((path) =>
    OSS_SYNC_EXCLUDED_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix))
  );
  if (privatePaths.length > 0) {
    throw new Error(`OSS sync contains private paths: ${privatePaths.join(", ")}`);
  }
}

if (import.meta.main) {
  const paths = process.argv.slice(2).map((path) => path.trim()).filter(Boolean);
  if (paths.length === 0) {
    throw new Error(
      "usage: bun scripts/assert-oss-sync-safe.ts $(git diff --name-only <base>..<head>)",
    );
  }
  assertOssSyncSafe(paths);
  console.log(`OSS_SYNC_BOUNDARY_OK files=${paths.length}`);
}
