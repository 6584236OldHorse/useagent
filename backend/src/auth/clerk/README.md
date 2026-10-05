# Control-plane identity cutover

Clerk is the default. Local user, organization, and membership IDs remain the
tenancy model. Existing Better Auth cookies are not accepted in Clerk mode.

## Configuration

- Configure Google, enable Organizations and organization slugs, and set the
  Clerk access mode to Restricted when production self-signup is disabled.
- Register `https://app.useagent.org/api/auth/clerk/webhook` for user,
  organization, and organization-membership created, updated, and deleted events.
  Both published membership event spellings are accepted by the receiver.
- Set `CLERK_SECRET_KEY` and `CLERK_WEBHOOK_SECRET` in the backend host environment.
  Use `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` from the same instance. Never put the
  secret key in a client build argument or commit an environment file.
- Release images read the publishable key from the repository Actions variable
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`. The frontend receives only its server-side
  identity secret at runtime, not the backend's other credentials.

The supplied development instance is intentional. Its development badge and
service limits remain; changing instances later also requires migrating identity
bindings, not merely assuming another instance has the same user IDs.

## Migration

Apply the additive SQL migration before switching authentication. Run the script
in a one-off process using the backend's existing environment, not a second HTTP
backend connected to the same database:

```sh
cd backend
bun run scripts/clerk-migrate.ts --check
bun run scripts/clerk-migrate.ts --execute
```

`--check` is read-only and prints local counts, including pending invitations.
It is not a remote capability certification. `--execute` first checks required
organization settings, all remote identity reuse, and existing remote membership
ownership. Pending legacy invitations must be resolved or reissued before it can
proceed. No local rows are silently excluded.

A same-slug organization is reusable only with migration-owned private metadata
identifying its local organization. An unexplained slug collision or unexpected
remote member stops the migration; do not mark an unrelated organization as owned.

The migration locks identity writes, snapshots the source, and commits every
local binding together. Reads continue. Webhook reconciliation cannot prune a
membership between phases. Remote API operations are not transactional: after a
failure, resolve its cause and rerun; email and trusted organization provenance
make already-created remote objects reusable. Successful output contains counts,
not credentials or identity values.

## Cutover and rollback

Verify existing-user sign-in, organization selection, and webhook delivery before
opening the new frontend. A missing membership remains `403 no_organization`;
provider sign-out and organization controls remain available for recovery.

For the one-release escape hatch, pair backend `AUTH=better-auth` with a frontend
built using `NEXT_PUBLIC_AUTH=better-auth`. The frontend switch is a build input:
changing a running container's environment does not rewrite its browser bundle.
Source deployments rebuild with matching inputs; immutable deployments must use
the matching rebuilt frontend image or the previous complete release.

While the backend uses Better Auth, the webhook receiver returns retryable 503
without applying identity changes. Do not acknowledge and discard those events.
Legacy tables and product ownership records are retained for rollback. Return to
Clerk with the matching frontend and let queued notifications reconcile current
remote state.
