#!/usr/bin/env bash
# A control plane on this machine for certifying the local sandbox provider:
# a throwaway database, the backend, the separate gateway process, one runner
# against it, then runs. Keys come from an env file sourced into this shell
# only; every address, port and database is overridden after the source.
#
#   IMAGE_REF=127.0.0.1:5000/sandbox:dev IMAGE_DIGEST=sha256:... certify/stack.sh db
#   ... stack.sh backend | gateway            (long-running; one terminal each)
#   ... stack.sh enrol                        (prints the runner token once)
#   USEAGENT_RUNNER_TOKEN=... stack.sh runner docker|apple
#   ... stack.sh config | runners | run [engine] [model] [prompt] | show <runId>
#
# Docker: SANDBOX_HOST=host.docker.internal (default). Apple containers:
# SANDBOX_HOST=192.168.64.1 USEAGENT_BIND_HOST=192.168.64.1 for the gateway, and
# an image reference on the machine's IPv4 name (localhost:5000 is AirPlay).
set -euo pipefail

REPO=${USEAGENT_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}
ENV_FILE=${USEAGENT_ENV_FILE:-$REPO/backend/.env}
CERT_PORT=${CERT_PORT:-3402}
GATEWAY_PORT=${GATEWAY_PORT:-3423}
DB=${DB:-useagent_local_cert}
PG=${PG_ADMIN_URL:-postgres://postgres@127.0.0.1:5433/postgres}
DATABASE_URL=${PG%/*}/$DB
IMAGE_REF=${IMAGE_REF:?SANDBOX_IMAGE_REF}
IMAGE_DIGEST=${IMAGE_DIGEST:?SANDBOX_IMAGE_DIGEST}
SANDBOX_HOST=${SANDBOX_HOST:-host.docker.internal}
RUNNER_BIN=${RUNNER_BIN:-$REPO/packages/runner/dist/useagent-runner-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/')}

case ${1:-} in
  db)
    TEST_ADMIN_URL=$PG TEST_DATABASE_URL=$DATABASE_URL bun run "$REPO/backend/test/prepare-db.ts"
    ;;
  backend|gateway)
    set -a; source "$ENV_FILE"; set +a
    export DATABASE_URL PORT=$CERT_PORT ALLOW_DEV_ORG=1 NODE_ENV=development USEAGENT_DEV_MODE=true
    export FRONTEND_ORIGIN=http://localhost:3400 BETTER_AUTH_URL=http://localhost:$CERT_PORT
    export SANDBOX_IMAGE_REF=$IMAGE_REF SANDBOX_IMAGE_DIGEST=$IMAGE_DIGEST
    export RUNTIME_ENVIRONMENT_ENABLED=1 ENABLED_ENGINES=${ENABLED_ENGINES:-opencode,claude,codex}
    # The sandbox reaches models and tools through the gateway process at an address it can route to.
    export GATEWAY_PORT GATEWAY_PUBLIC_URL=http://$SANDBOX_HOST:$GATEWAY_PORT PROVIDER_GATEWAY_PUBLIC_URL=http://$SANDBOX_HOST:$GATEWAY_PORT
    export USEAGENT_API_ORIGIN=http://127.0.0.1:$CERT_PORT
    export ENGINE_READINESS_OPENCODE=healthy ENGINE_READINESS_CODEX=healthy ENGINE_READINESS_CLAUDE=healthy
    # Nothing on this stack may join the team's channels or memory.
    unset SLACK_APP_TOKEN SLACK_BOT_TOKEN SLACK_SIGNING_SECRET SLACK_USER_TOKEN GITHUB_APP_PRIVATE_KEY GITHUB_TOKEN MEMORY_API_URL
    if [[ $1 == gateway ]]; then
      export GATEWAY_DATABASE_URL=$DATABASE_URL
      cd "$REPO/backend" && exec bun run src/gateway.ts
    fi
    cd "$REPO/backend" && exec bun run src/index.ts
    ;;
  enrol)
    curl -fsS -X POST "http://127.0.0.1:$CERT_PORT/api/runners/enrol" -H 'content-type: application/json' \
      -d "{\"name\":\"${RUNNER_NAME:-cert-$(hostname -s)}\",\"platform\":\"$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)\"}"
    ;;
  runner)
    : "${USEAGENT_RUNNER_TOKEN:?the token from enrol}"
    exec "$RUNNER_BIN" --plane "http://127.0.0.1:$CERT_PORT" --backend "${2:-docker}" --share-logins "${SHARE_LOGINS:-codex,claude,opencode}"
    ;;
  config)
    curl -fsS "http://127.0.0.1:$CERT_PORT/api/config" | bun -e 'const c = await new Response(Bun.stdin).json(); console.log(JSON.stringify({ engines: c.engines, runner: c.runner, models: c.models }, null, 1))'
    ;;
  runners)
    curl -fsS "http://127.0.0.1:$CERT_PORT/api/runners" | bun -e 'console.log(JSON.stringify(await new Response(Bun.stdin).json(), null, 1))'
    ;;
  run)
    cd "$(dirname "${BASH_SOURCE[0]}")" && PLANE=http://127.0.0.1:$CERT_PORT exec bun run run.ts "${2:-opencode}" "${3:-}" "${4:-}"
    ;;
  show|terminal)
    cd "$(dirname "${BASH_SOURCE[0]}")" && PLANE=http://127.0.0.1:$CERT_PORT exec bun run run.ts "$1" "${2:?runId}"
    ;;
  *)
    echo "usage: stack.sh db|backend|gateway|enrol|runner [docker|apple]|config|runners|run [engine] [model] [prompt]|show <runId>|terminal <runId>" >&2; exit 2;;
esac
