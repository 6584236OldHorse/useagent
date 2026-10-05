# @useagent/runner-protocol

The link between a per-machine runner and the control plane: one outbound
WebSocket from the runner, multiplexed into RPC calls and independent byte
streams. The runner (`packages/runner`) and the local sandbox plugin
(`packages/sandbox-local`) both depend on this package, so a method's params
and result have one definition.

Pure TypeScript on web standards (Promise, ReadableStream). No Bun or Node
imports, no dependencies.

## Frames (`src/frames.ts`)

Text frames are JSON control frames: `hello`, `welcome`, `heartbeat`, `rpc`,
`rpc.result`, `rpc.error`, `stream.open`, `stream.opened`, `stream.refused`,
`stream.credit`, `stream.close`, `stream.reset`, `event`. Binary frames carry
stream payload: one tag byte, a big-endian 32-bit stream id, the bytes.

A peer ignores frames and fields it does not know. That is the additive rule
behind `PROTOCOL_VERSION` (`src/version.ts`).

## Mux (`src/mux.ts`)

`new Mux(role, transport, handlers, options)` turns a socket into:

- `rpc(method, params)` with a timeout and typed error codes (`RpcError`).
- `openStream(target)` returning a `MuxStream`: a `readable`, `write()` that
  waits for the peer's window, `end()` for a half-close, `reset()` to abort.
- Per-stream credit windows. Credit is returned as the consumer drains, so a
  stalled noVNC canvas slows only itself, never the runtime session next to it.
- Stream ids by role: the plane opens even ids, the runner odd ones.

The transport is anything with `send(string | Uint8Array)`; feed incoming
socket messages to `mux.receive()` and call `mux.close()` when the socket
drops so every pending call and stream fails at once.

## Methods and targets (`src/methods.ts`)

`RunnerRpcCatalog` lists every RPC the plane calls on a runner (sandbox
lifecycle, process execution, session commands, file details, PTY resize).
`StreamTarget` lists the byte streams the plane opens into a sandbox: a TCP
port, a PTY, a file read or write, a live command log.

`composeLocalSandboxId` and `parseLocalSandboxId` define the sandbox id the
control plane records for a runner's container: `local:<runnerId>:<containerId>`.
