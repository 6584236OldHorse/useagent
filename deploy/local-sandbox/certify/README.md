# Certifying the local provider on one machine

The hosted release gate cannot attach a developer's machine, so the `local`
provider is certified by hand with this recipe and the record goes under
`deploy/hetzner/evidence/local/`. The plane runs on the machine too; the only
difference from a hosted plane is the address the sandbox uses to reach the
gateway process.

1. Build and publish the image (`deploy/local-sandbox/README.md`), note its
   digest. On a Mac, publish to a registry on the machine's IPv4 name
   (`127.0.0.1:5000/...`): Apple's `container` resolves `localhost` to the
   AirPlay listener on port 5000.
2. Build the runner: `cd packages/runner && bun run build`.
3. Throwaway Postgres on :5433, then in separate terminals with
   `IMAGE_REF` and `IMAGE_DIGEST` exported:
   `stack.sh db`, `stack.sh backend`, `stack.sh gateway`.
   Docker: defaults. Apple containers: `SANDBOX_HOST=192.168.64.1` for both,
   `USEAGENT_BIND_HOST=192.168.64.1` for the gateway.
4. `stack.sh enrol` once; keep the token in the shell that starts the runner:
   `USEAGENT_RUNNER_TOKEN=... stack.sh runner docker` (or `apple`).
5. `stack.sh config` shows `runner.image` at the digest; `stack.sh runners`
   shows the machine online with its logins and capacity.
6. Per engine: `stack.sh run <engine> [model]`, then
   `stack.sh terminal <runId>` and `curl /api/port-proxy/<runId>/8765/`.
7. Runner death: start a long run, `kill -9` the runner, watch the run settle
   as interrupted and the machine go offline; restart the runner and confirm
   it adopts its containers. Fallback: with the runner stopped, create a run
   and confirm it binds to the deployment provider.

Keys come from `backend/.env` of the checkout (or `USEAGENT_ENV_FILE`); the
script never copies the file. Slack, GitHub and memory settings are dropped so
the stack cannot join the team's channels.
