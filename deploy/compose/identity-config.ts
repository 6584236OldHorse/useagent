function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function frontendEnvironmentPreparationCommand(backendEnv: string, frontendEnv: string): string {
  return `set -eu; set -a; . ${quote(backendEnv)}; set +a; ` +
    `tmp=$(mktemp ${quote(`${frontendEnv}.XXXXXX`)}); trap 'rm -f -- "$tmp"' EXIT; ` +
    `printf '%s\\n' "CLERK_SECRET_KEY=\${CLERK_SECRET_KEY:-}" > "$tmp"; ` +
    `chmod 600 "$tmp"; mv -f -- "$tmp" ${quote(frontendEnv)}; trap - EXIT`;
}

/** Validate the immutable images before warming the edge or closing admission. */
export function identityReleaseValidationCommand(backendEnv: string, backendImage: string, frontendImage: string): string {
  return `set -eu; . ${quote(backendEnv)}; ` +
    `backend_default=$(docker image inspect --format '{{ index .Config.Labels "io.useagent.auth.default" }}' ${quote(backendImage)}); ` +
    `frontend_auth=$(docker image inspect --format '{{ index .Config.Labels "io.useagent.auth" }}' ${quote(frontendImage)}); ` +
    // Pre-Clerk releases have neither label and use Better Auth unconditionally.
    `case "$backend_default" in ''|'<no value>') backend_auth=better-auth ;; clerk) backend_auth=\${AUTH:-clerk} ;; *) echo 'invalid backend auth metadata' >&2; exit 2;; esac; ` +
    `case "$frontend_auth" in ''|'<no value>') frontend_auth=better-auth ;; clerk|better-auth) ;; *) echo 'invalid frontend auth metadata' >&2; exit 2;; esac; ` +
    `test "$backend_auth" = "$frontend_auth" || { echo 'frontend and backend auth modes do not match' >&2; exit 2; }; ` +
    `if [ "$backend_auth" = clerk ]; then test -n "\${CLERK_SECRET_KEY:-}" || { echo 'Clerk secret is missing' >&2; exit 2; }; fi`;
}
