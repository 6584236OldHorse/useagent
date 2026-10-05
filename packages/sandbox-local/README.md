# @useagent/sandbox-local

A developer's own machine behind the `SandboxProvider` contract, as a provider
plugin. The control plane never reaches the machine: the machine's runner
(`packages/runner`) holds one outbound link, and this provider is an RPC client
over it. `localPlugin` in `src/plugin.ts` is everything the control plane
needs: the runtime layout (non-root `/home/user`), the image from
`SANDBOX_IMAGE_REF` and `SANDBOX_IMAGE_DIGEST`, resources from `SANDBOX_CPU`
and `SANDBOX_MEMORY_GIB`, and a provider factory.

## How a call travels

`SandboxProvider.create` becomes `sandbox.create` on the runner; process,
session and file calls become the RPCs in `@useagent/runner-protocol`; a PTY,
a file transfer and a live log are byte streams over the same link. A preview
link is a loopback address on the control plane (a forwarder the runner
registry opens) so the port, desktop and runtime proxies keep fetching plain
HTTP without knowing a runner exists.

Sandbox ids are `local:<runnerId>:<containerId>`, so a recorded run resolves
to its machine by id alone. A machine that is enrolled but away answers
`RunnerOfflineError` ("not connected"), never "not found", so nothing replaces
its sandbox.

## Ports

The provider needs `SandboxProviderPorts.links`, the control plane's
`SandboxLinkDirectory` (`backend/src/runners/registry.ts`). `fakeLink` and
`fakeLinkDirectory` in `src/fake-link.ts` stand in for a machine in tests.
