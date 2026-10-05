// Which view of runners this process has. The backend owns the links and the
// loopback forwarders; the tool gateway (a separate process, marked by
// GATEWAY_DATABASE_URL) knows the machines from the database and reaches them
// through the backend's bridge.

import type { SandboxLinkDirectory } from "@useagent/sandbox-contract";
import { type LiveRunner, runnerRegistry } from "./registry";
import { type KnownRunner, remoteRunnerDirectory } from "./remote-directory";

export function isGatewayProcess(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return Boolean(env.GATEWAY_DATABASE_URL?.trim());
}

export function activeRunnerDirectory(): SandboxLinkDirectory {
  return isGatewayProcess() ? remoteRunnerDirectory : runnerRegistry.directory;
}

/** What sandbox binding asks about machines, answered by whichever view this process has. */
export interface RunnerSeam {
  readonly onlineForUser: (orgId: string, userId: string) => LiveRunner | KnownRunner | null;
  readonly runner: (runnerId: string) => LiveRunner | KnownRunner | null;
  /** Bring this process's view of machines up to date before a local sandbox resolves. */
  readonly refresh: () => Promise<void>;
}

export function activeRunnerSeam(): RunnerSeam {
  if (isGatewayProcess()) {
    return {
      // New runs are bound in the backend process; the gateway only serves existing ones.
      onlineForUser: () => null,
      runner: (runnerId) => remoteRunnerDirectory.runner(runnerId),
      // Machines enrol and reconnect after the gateway booted; the backend records each change.
      refresh: async () => {
        await remoteRunnerDirectory.refresh();
      },
    };
  }
  return {
    onlineForUser: (orgId, userId) => runnerRegistry.onlineForUser(orgId, userId),
    runner: (runnerId) => runnerRegistry.runner(runnerId),
    refresh: async () => {},
  };
}
