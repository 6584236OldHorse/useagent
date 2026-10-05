# Native runtime assets

The backend image carries one immutable native runtime archive for sandbox
providers that do not have the runtime preinstalled. The archive is a release
asset, not committed to Git.

`backend/runtime-assets/manifest.json` pins the release filename, archive hash,
embedded checksum-manifest hash, source commit, dependency version, and frozen
Bun dependency-lock hash. The archive is built from reviewed fork commit
`762f4b14b328829b667b65cbe3a081f9af2a191e`, based on upstream `v0.0.45`
(`6c8fed35dded9ff71c5b46807125457acbb76be6`). It is the server's `dist`
directory with its bundled web client, plus a `T3_SOURCE_COMMIT` marker and a
`SHA256SUMS` manifest of every file. Artifact identity is not live
engine/provider certification.

## Layout in a sandbox

Since `v0.0.45` the server bundle inlines its JavaScript dependencies and leaves
only native packages external: `@ff-labs/fff-node`, `node-pty` and
`@napi-rs/keyring`. The upstream npm package is now a launcher for prebuilt
single executables, so it is not installed. The runtime root holds:

- `node_modules/`: the frozen closure from `backend/runtime-assets/dependencies/`
  (`package.json` plus `bun.lock`, installed with `bun install --frozen-lockfile`;
  `node-pty` is built with the sandbox's Node toolchain),
- `dist/`: the verified fork archive, resolving its externals from the
  neighbouring `node_modules`,
- `bin/t3`: a launcher that runs `node dist/bin.mjs`; installation checks it
  prints `t3 v<dependencyVersion>`.

The dependency `package.json` carries the runtime release it was frozen for as
its own `version`, and the stage script checks it against the manifest. The
dependency directory's `node_modules` stays ignored and is never packaged.

Reuse probes detect damaged files, launchers, and dependency symlinks. They are
corruption/reproducibility checks, not remote attestation against tenant code
with full access to a sandbox's tools and process environment. Credential
isolation remains the separate responsibility of the trusted control plane.

## Staging

```sh
bun run deploy/stage-native-runtime.ts /path/to/native-runtime-762f4b14b328.tar.gz
```

Without an argument, the script downloads the exact filename from the public
`useagenthq/useagent` release `native-runtime-<first 12 of sourceCommit>` with
the `gh` CLI, so checkouts without a credential stage the same bytes. It
verifies the outer archive hash, embedded source marker, embedded `SHA256SUMS`
hash, tracked dependency lock and dependency version before atomically placing
the ignored archive under `backend/runtime-assets/`.

The backend Docker build carries the staged archive under
`/app/backend/runtime-assets/`, exposes stable links from
`/opt/useagent/native-runtime/`, and repeats the verification. Missing or
changed bytes fail the image build. CI stages the same release asset before
every backend image build.

## Publishing a replacement

Build a new uniquely named archive and manifest. Never overwrite a release asset
or reuse an archive filename for different bytes. Publish the archive and the
fork patch on a new public `native-runtime-<sha12>` release, and the archive,
bundle and patch on a new private release. A runtime distribution change does
not change harness protocol selection: Codex, Claude Code, OpenCode, and Pi
remain on their native engine drivers.

The matching `t3code-fork-762f4b14b328.bundle` and `.patch` preserve the custom
source; their hashes and upstream prerequisite commit are recorded in
`third_party/t3code-fork.lock`. Fetch the upstream prerequisite before using
the Git bundle. The v8 wire/session compatibility label is separate from byte
identity.

## Runtime state on retained sandboxes

The runtime's SQLite schema migrates forward on boot (`v0.0.45` takes a
`v0.0.39` database to its current schema); projects, threads, and workspace
paths survive. A previous runtime still boots on the migrated database and
reads the same threads, so a rollback does not need a fresh runtime database.
Intentional migration data repairs are not reversed by an application rollback.

## History

- `v0.0.4` (2026-09): fork `90dc3ebbb74b` on upstream
  `v0.0.39-nightly.20260906.1293`, installed by overlaying the fork's `dist` on
  the registry `t3` package.
- 2026-10-03: fork `762f4b14b328` on upstream `v0.0.45`; the fork `dist` sits
  beside a three-package native closure, `fff-node` is imported statically, and
  thread reads use a two-turn window.
