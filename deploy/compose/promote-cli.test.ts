import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertGatesCanRollBack,
	type Certification,
	certifyOrRollback,
	inlineGates,
	parseArgs,
	reportedError,
	reportedStatus,
	runInlineGate,
} from "../promote";
import type { PromotionResult } from "./promotion";
import { emptyReleaseHistory, type ReleaseRecord } from "./release-config";
import {
	type RemoteHost,
	SshPromotionEffects,
	type SshPromotionConfig,
} from "./ssh-promotion-effects";

const config: SshPromotionConfig = {
	sshHost: "root@example.test",
	sshKey: null,
	sshConfig: null,
	sshControlPath: "/tmp/useagent-promote-cli-test.sock",
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
const live: ReleaseRecord = {
	color: "blue",
	promotedAt: "2026-09-08T00:00:00.000Z",
	manifest: {
		commit: "a".repeat(40),
		backend: `registry.example/backend@sha256:${"b".repeat(64)}`,
		gateway: `registry.example/gateway@sha256:${"c".repeat(64)}`,
		frontend: `registry.example/frontend@sha256:${"d".repeat(64)}`,
	},
};
const complete: PromotionResult = {
	status: "complete",
	history: emptyReleaseHistory(),
};
const failedClosed: PromotionResult = {
	status: "failed-closed",
	history: emptyReleaseHistory(),
	error: "no healthy backend available for recovery",
};

describe("promote CLI flags", () => {
	test("the fast path is the default: no gates, bounded drain", () => {
		const args = parseArgs(["promote", "--manifest", "release-manifest.json"]);
		expect(args.command).toBe("promote");
		expect(args.manifestPath?.endsWith("/release-manifest.json")).toBe(true);
		expect(args.gates).toBe(false);
		expect(args.drain).toBe(true);
	});

	test("explicit flags are accepted in any order for promote and rollback", () => {
		expect(
			parseArgs(["promote", "--no-drain", "--gates", "--manifest", "m.json"]),
		).toMatchObject({ gates: true, drain: false });
		expect(
			parseArgs(["promote", "--manifest", "m.json", "--skip-gates", "--drain"]),
		).toMatchObject({ gates: false, drain: true });
		expect(parseArgs(["rollback"])).toMatchObject({
			command: "rollback",
			manifestPath: null,
			gates: false,
			drain: true,
		});
		expect(parseArgs(["rollback", "--no-drain"]).drain).toBe(false);
	});

	test("rejects contradictory, repeated, unknown, and misplaced flags", () => {
		for (const argv of [
			["promote", "--manifest", "m.json", "--gates", "--skip-gates"],
			["promote", "--manifest", "m.json", "--drain", "--no-drain"],
			["promote", "--manifest", "m.json", "--gates", "--gates"],
			["promote", "--gates"],
			["promote", "--manifest", "--gates"],
			["promote", "--manifest", "m.json", "--manifest", "n.json"],
			["promote", "--manifest", "m.json", "--certify"],
			["rollback", "--gates"],
			["rollback", "--skip-gates"],
			["rollback", "--manifest", "m.json"],
			["certify"],
		]) {
			expect(() => parseArgs(argv)).toThrow("usage:");
		}
	});

	test("adopt-systemd keeps its strict shape and never takes the new flags", () => {
		const commit = "f".repeat(40);
		expect(
			parseArgs(["adopt-systemd", "--manifest", "m.json", "--legacy-commit", commit]),
		).toMatchObject({
			command: "adopt-systemd",
			legacyCommit: commit,
			gates: false,
			drain: true,
		});
		expect(() =>
			parseArgs([
				"adopt-systemd",
				"--manifest",
				"m.json",
				"--legacy-commit",
				commit,
				"--no-drain",
			]),
		).toThrow("usage:");
	});

	test("--gates is refused on a bootstrap promotion with nothing to roll back to", () => {
		expect(() => assertGatesCanRollBack(emptyReleaseHistory())).toThrow(
			"--gates requires a live release",
		);
		expect(() =>
			assertGatesCanRollBack({ ...emptyReleaseHistory(), current: live }),
		).not.toThrow();
	});
});

describe("inline gates", () => {
	test("runs every gate in order and never rolls back when all pass", async () => {
		const ran: string[] = [];
		let rollbacks = 0;
		const result = await certifyOrRollback({
			gates: inlineGates,
			runGate: async (gate) => {
				ran.push(gate.name);
				return null;
			},
			rollback: async () => {
				rollbacks += 1;
				return complete;
			},
		});
		expect(ran).toEqual(inlineGates.map((gate) => gate.name));
		expect(rollbacks).toBe(0);
		expect(result).toEqual({
			failedGate: null,
			reason: null,
			rollback: null,
			rollbackError: null,
			rollbackMs: null,
		});
	});

	test("the first failure rolls back with its reason and skips the remaining gates", async () => {
		const failing = inlineGates[1]?.name ?? "";
		const ran: string[] = [];
		const result = await certifyOrRollback({
			gates: inlineGates,
			runGate: async (gate) => {
				ran.push(gate.name);
				return gate.name === failing ? "exit 1" : null;
			},
			rollback: async () => complete,
		});
		expect(ran).toHaveLength(2);
		expect(result).toMatchObject({
			failedGate: failing,
			reason: "exit 1",
			rollback: complete,
			rollbackError: null,
		});
		expect(result.rollbackMs).toBeGreaterThanOrEqual(0);
	});

	test("a gate that throws while launching still rolls back", async () => {
		let rollbacks = 0;
		const result = await certifyOrRollback({
			gates: inlineGates,
			runGate: async () => {
				throw new Error("spawn bun ENOENT");
			},
			rollback: async () => {
				rollbacks += 1;
				return complete;
			},
		});
		expect(rollbacks).toBe(1);
		expect(result).toMatchObject({
			failedGate: inlineGates[0]?.name,
			reason: "spawn bun ENOENT",
			rollback: complete,
		});
	});

	test("a rollback that throws is reported instead of escaping", async () => {
		const result = await certifyOrRollback({
			gates: inlineGates,
			runGate: async () => "exit 2",
			rollback: async () => {
				throw new Error("rollback requires a previous release");
			},
		});
		expect(result).toMatchObject({
			failedGate: inlineGates[0]?.name,
			reason: "exit 2",
			rollback: null,
			rollbackError: "rollback requires a previous release",
		});
	});

	test("only operator-side public-origin canaries run inline, cheapest first", () => {
		expect(inlineGates.map((gate) => gate.script)).toEqual([
			"product-child-post-promotion-smoke.ts",
			"hosted-release-canary.ts",
			"advertised-model-canary.ts",
		]);
		expect(
			inlineGates.find((gate) => gate.script === "hosted-release-canary.ts")?.env,
		).toEqual({ HOSTED_RELEASE_PHASE: "post-promotion" });
	});

	test("a gate child is bounded: pass, nonzero exit, and timeout are distinct", async () => {
		const directory = await mkdtemp(join(tmpdir(), "useagent-gate-"));
		try {
			const script = async (name: string, body: string) => {
				const path = join(directory, name);
				await writeFile(path, body);
				await chmod(path, 0o644);
				return path;
			};
			const env = { USEAGENT_BASE_URL: "https://app.example.test" };
			const pass = await script("pass.ts", "process.exit(0);\n");
			const fail = await script("fail.ts", "process.exit(3);\n");
			const hang = await script("hang.ts", "await Bun.sleep(60_000);\n");
			expect(await runInlineGate({ name: "pass", script: pass, env: {} }, env)).toBeNull();
			expect(await runInlineGate({ name: "fail", script: fail, env: {} }, env)).toBe(
				"exit 3",
			);
			const startedAt = Date.now();
			expect(
				await runInlineGate({ name: "hang", script: hang, env: {} }, env, 500),
			).toBe("timed out after 500ms");
			expect(Date.now() - startedAt).toBeLessThan(10_000);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("result reporting after gates", () => {
	const certified = (
		overrides: Partial<Certification>,
	): Certification => ({
		failedGate: "hosted-release",
		reason: "exit 1",
		rollback: complete,
		rollbackError: null,
		rollbackMs: 10,
		...overrides,
	});

	test("no gates: the controller's status and error pass through", () => {
		expect(reportedStatus(null, complete)).toBe("complete");
		expect(reportedError(null, complete)).toBeNull();
		expect(reportedStatus(null, failedClosed)).toBe("failed-closed");
		expect(reportedError(null, failedClosed)).toBe(failedClosed.error);
	});

	test("a failed gate never reports complete and names both the gate and the recovery", () => {
		const clean = certified({});
		expect(reportedStatus(clean, complete)).toBe("rolled-back");
		expect(reportedError(clean, complete)).toBe(
			"inline gate hosted-release failed: exit 1",
		);

		const stuck = certified({ rollback: failedClosed });
		expect(reportedStatus(stuck, failedClosed)).toBe("failed-closed");
		expect(reportedError(stuck, failedClosed)).toBe(
			"inline gate hosted-release failed: exit 1; rollback failed-closed: no healthy backend available for recovery",
		);

		const threw = certified({ rollback: null, rollbackError: "ssh timed out" });
		expect(reportedStatus(threw, complete)).toBe("rollback-error");
		expect(reportedError(threw, complete)).toBe(
			"inline gate hosted-release failed: exit 1; rollback threw: ssh timed out",
		);
	});
});

describe("drain flag", () => {
	function effectsWith(
		drain: boolean,
		run: (command: string) => Promise<{ code: number; stdout: string; stderr: string }>,
	): SshPromotionEffects {
		return new SshPromotionEffects({
			config,
			remote: { run } as unknown as RemoteHost,
			history: { ...emptyReleaseHistory(), current: live },
			target: { ...live, color: "green" },
			kind: "promote",
			composeFile: "fixture",
			caddyTemplate: "fixture",
			drain,
			crash: async () => {
				throw new Error("unused");
			},
		});
	}

	test("--no-drain answers the drain phase without touching the host", async () => {
		const effects = effectsWith(false, async () => {
			throw new Error("no remote call expected");
		});
		expect(await effects.drainBackend(10_000)).toBe(true);
	});

	test("the default drain polls the live backend for in-flight runs", async () => {
		const commands: string[] = [];
		const effects = effectsWith(true, async (command) => {
			commands.push(command);
			return { code: 0, stdout: '{"count":0}', stderr: "" };
		});
		expect(await effects.drainBackend(10_000)).toBe(true);
		expect(commands).toHaveLength(1);
		expect(commands[0]).toContain("deployment-inflight");
	});
});
