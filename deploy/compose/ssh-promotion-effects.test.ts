import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseRecord } from "./release-config";
import {
	backendScratchPreparationCommands,
	RemoteHost,
	type SshPromotionConfig,
} from "./ssh-promotion-effects";
import { frontendEnvironmentPreparationCommand, identityReleaseValidationCommand } from "./identity-config";

const config: SshPromotionConfig = {
	sshHost: "root@example.test",
	sshKey: null,
	sshConfig: null,
	sshControlPath: "/tmp/useagent-promote-test.sock",
	appDomain: "app.example.test",
	gatewayDomain: "gateway.example.test",
	publicGatewayUrl: "https://gateway.example.test",
	backendEnvFile: "/etc/useagent/backend.env",
	gatewayEnvFile: "/etc/useagent/gateway.env",
	remoteRoot: "/var/lib/useagent",
	historyPath: "/var/lib/useagent/release-history.json",
	caddyConfigPath: "/etc/caddy/Caddyfile",
	caddyEnvFile: "/etc/useagent/caddy.env",
	composeSource: "/workspace/compose.prod.yaml",
	caddyTemplateSource: "/workspace/deploy/compose/Caddyfile",
	crashAfter: null,
};

describe("SSH promotion transport", () => {
	test("rejects mixed auth images and preserves pre-Clerk rollback semantics", async () => {
		const directory = await mkdtemp(join(tmpdir(), "useagent-identity-image-"));
		try {
			const backendEnv = join(directory, "backend.env");
			const docker = join(directory, "docker");
			await writeFile(docker, '#!/bin/sh\ncase "$*" in *backend-image*) printf "%s" "$BACKEND_AUTH" ;; *) printf "%s" "$FRONTEND_AUTH" ;; esac\n');
			await chmod(docker, 0o755);
			for (const [backendDefault, backendMode, frontendMode, pass] of [
				["clerk", "clerk", "clerk", true], ["clerk", "better-auth", "clerk", false],
				["clerk", "clerk", "better-auth", false], ["clerk", "better-auth", "better-auth", true],
				["", "clerk", "", true], ["clerk", "", "clerk", true],
			] as const) {
				await writeFile(backendEnv, `AUTH=${backendMode}\nCLERK_SECRET_KEY=fixture-not-a-key\n`);
				const result = Bun.spawnSync(["bash", "-c", identityReleaseValidationCommand(backendEnv, "backend-image", "frontend-image")], {
					env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, BACKEND_AUTH: backendDefault, FRONTEND_AUTH: frontendMode }, stdout: "pipe", stderr: "pipe",
				});
				expect(result.exitCode === 0).toBe(pass);
			}
		} finally { await rm(directory, { recursive: true }); }
	});
	test("captures release auth so compensation ignores later host changes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "useagent-frontend-env-"));
		try {
			const backendEnv = join(directory, "backend.env");
			const frontendEnv = join(directory, "frontend.env");
			await writeFile(
				backendEnv,
				[
					"CLERK_SECRET_KEY=sk_test_example",
					"DATABASE_URL=must-not-cross-the-boundary",
				].join("\n"),
			);

			const result = Bun.spawnSync(
				[
					"bash",
					"-c",
					frontendEnvironmentPreparationCommand(backendEnv, frontendEnv),
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			expect(result.exitCode).toBe(0);
			expect(await readFile(frontendEnv, "utf8")).toBe(
        ["AUTH=clerk", "CLERK_SECRET_KEY=sk_test_example", ""].join("\n"),
			);

			await writeFile(
				backendEnv,
				"AUTH=better-auth\nDATABASE_URL=still-private\n",
			);
			const legacyResult = Bun.spawnSync(
				[
					"bash",
					"-c",
					frontendEnvironmentPreparationCommand(backendEnv, frontendEnv),
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			expect(legacyResult.exitCode).toBe(0);
      expect(await readFile(frontendEnv, "utf8")).toBe("AUTH=better-auth\nCLERK_SECRET_KEY=\n");
      await writeFile(backendEnv, "AUTH=clerk\nCLERK_SECRET_KEY=new-candidate-key\n");
      const restored = Bun.spawnSync(["bash", "-c", '. "$1"; printf "%s" "$AUTH"', "fixture", frontendEnv], {stdout:"pipe",stderr:"pipe"});
      expect(restored.stdout.toString()).toBe("better-auth");
		} finally {
			await rm(directory, { recursive: true });
		}
	});

	test("reuses one task-scoped SSH connection without a global socket", () => {
		const args = new RemoteHost(config).sshArgs();
		expect(args).toContain("ControlMaster=auto");
		expect(args).toContain("ControlPersist=60");
		expect(args).toContain("ControlPath=/tmp/useagent-promote-test.sock");
		expect(args).not.toContain("ControlPath=none");
	});

	test("repairs and probes the disk-backed backend scratch mount before cutover", () => {
		const record: ReleaseRecord = {
			color: "green",
			promotedAt: "2026-09-04T00:00:00.000Z",
			manifest: {
				commit: "a".repeat(40),
				backend: `registry.example/backend@sha256:${"b".repeat(64)}`,
				gateway: `registry.example/gateway@sha256:${"c".repeat(64)}`,
				frontend: `registry.example/frontend@sha256:${"d".repeat(64)}`,
			},
		};
		const commands = backendScratchPreparationCommands(config, record);

		expect(commands).toHaveLength(2);
		expect(commands[0]).toContain('install -d -o "$uid" -g "$gid" -m 0770');
		expect(commands[0]).toContain("'/var/lib/useagent/scratch/green'");
		expect(commands[1]).toContain("run --rm --no-deps --entrypoint sh backend");
		expect(commands[1]).toContain("/var/lib/useagent/scratch/green/.useagent-scratch-");
	});
});
