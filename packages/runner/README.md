# @useagent/runner

The per-machine runner. It lends a developer's machine to the control plane
as a sandbox provider: threads run in Linux containers here, from the same
native image the cloud boots, while the record, memory, skills and bots stay
on the plane. The runner opens one outbound WebSocket; nothing connects in.

```
useagent-runner --plane https://app.useagent.org [--backend auto|docker|apple] [--share-logins codex,claude,opencode]
USEAGENT_RUNNER_TOKEN=uart_<runnerId>.<secret>
```

Exit codes: 0 clean stop, 1 usage, 2 token rejected, 3 no container backend,
4 control plane too old, 5 runner too old (update). One JSON line per state
change on stdout: `{"state":"starting|pulling|online|offline|error","detail":...,"progress":0..1}`.

## Parts

- `src/link.ts`: the link. Hello, welcome, heartbeat every 15 s with capacity
  and logins, reconnect with backoff, close codes 4401 (token rejected) and
  4426 (runner too old) end the link for good.
- `src/service.ts`: every RPC and stream target in `@useagent/runner-protocol`,
  over one `LocalBackend`. Every call names a container carrying this runner's
  label or is refused; nothing executes on the host.
- `src/backends/docker.ts`, `src/backends/apple.ts`: the two container engines
  through their command line tools, sharing `cli-backend.ts`. Docker dials a
  port with `socat` inside the container; an Apple container has its own
  address, so a dial is a TCP connect.
- `src/sessions.ts`: process sessions the way Box does them, inside the
  container under `/tmp/useagent/sessions`: sync commands with captured
  output, detached commands with pid, log and exit files and a FIFO on stdin.
- `src/logins.ts`: Codex, OpenCode and Claude logins on this machine, staged
  per login and mounted at `/run/useagent/logins/<name>`; the sandbox env
  names the file (`USEAGENT_LOGIN_CODEX=...`). Hard links flow refreshed tokens
  back; the Claude credential is written back to the keychain when a sandbox
  stops.
- `src/image.ts`: pull the image the plane names, verify its digest, keep it. The service runs that pull at the welcome and again on demand when a create finds the image missing (one pull per image at a time, bounded wait, the pull outlives the wait).

## Build

`bun run build` compiles `dist/useagent-runner-<platform>-<arch>` for macOS
arm64 and x64, Linux x64 and Windows x64 (the release asset names in the
contract with the desktop shell). `bun run build darwin-arm64` builds one.

## Tests

`bun test`. The Docker integration test builds a small image and runs the
session, file, port and terminal paths against a real container; it skips when
no Docker daemon answers. The Apple backend is exercised by hand on macOS.
