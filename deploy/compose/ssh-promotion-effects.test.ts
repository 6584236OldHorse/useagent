import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { emptyReleaseHistory, type ReleaseRecord } from "./release-config";
import {
	backendScratchPreparationCommands,
	RemoteHost,
	SshPromotionEffects,
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
  test("explicit rollback preserves either captured auth mode and only reconstructs pre-Clerk identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "useagent-identity-rollback-"));
    try {
      const backendEnv = join(directory, "backend.env");
      const record: ReleaseRecord = {color:"blue",promotedAt:"2026-09-08T00:00:00Z",manifest:{commit:"a".repeat(40),backend:"backend-image",gateway:"gateway-image",frontend:"frontend-image"}};
      const root = join(directory, "releases", `${record.manifest.commit}-blue`);
      const snapshot = join(root,"frontend.env");
      await mkdir(root,{recursive:true});
      await writeFile(join(directory,"docker"), '#!/bin/sh\ncase "$*" in *backend-image*) printf "%s" "$BACKEND_AUTH" ;; *) printf "%s" "$FRONTEND_AUTH" ;; esac\n');
      await chmod(join(directory,"docker"),0o755);
      for (const [oldMode, hostMode, missing] of [["clerk","better-auth",false],["better-auth","clerk",false],["","clerk",true],["clerk","clerk",true]] as const) {
        await writeFile(backendEnv,`AUTH=${hostMode}\nCLERK_SECRET_KEY=current-secret\n`);
        const captured = `AUTH=${oldMode}\nCLERK_SECRET_KEY=previous-secret\n`;
        if(missing) await rm(snapshot,{force:true}); else await writeFile(snapshot,captured);
        const remote = {
          async writeAtomic(path:string,text:string) { await mkdir(dirname(path),{recursive:true}); await writeFile(path,text); },
          async run(command:string) {
            if(command.startsWith("set -eu;")) {
              const result=Bun.spawnSync(["bash","-c",command],{env:{...process.env,PATH:`${directory}:${process.env.PATH}`,BACKEND_AUTH:oldMode?"clerk":"",FRONTEND_AUTH:oldMode},stdout:"pipe",stderr:"pipe"});
              if(result.exitCode!==0) throw new Error(result.stderr.toString()||"identity rejected");
              return {code:0,stdout:result.stdout.toString(),stderr:""};
            }
            return {code:0,stdout:command.includes('org.opencontainers.image.revision')?record.manifest.commit:"",stderr:""};
          },
        } as unknown as RemoteHost;
        const effects=new SshPromotionEffects({config:{...config,remoteRoot:directory,backendEnvFile:backendEnv},remote,history:{...emptyReleaseHistory(),current:{...record,color:"green"}},target:record,kind:"rollback",composeFile:"fixture",caddyTemplate:"fixture",crash:async()=>{throw new Error("unused");}});
        const prepared=effects.prepareRelease(record,{caddyConfig:"fixture",applyMigrations:false});
        if(missing&&oldMode) { await expect(prepared).rejects.toThrow("capture is missing"); expect(await Bun.file(snapshot).exists()).toBe(false); }
        else { await prepared; expect(await readFile(snapshot,"utf8")).toBe(missing?"AUTH=better-auth\nCLERK_SECRET_KEY=\n":captured); }
      }
    } finally { await rm(directory,{recursive:true}); }
  });
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
