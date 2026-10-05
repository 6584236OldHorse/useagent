import { dirname } from "node:path";

export interface SshPromotionConfig {
	readonly sshHost: string;
	readonly sshKey: string | null;
	readonly sshConfig: string | null;
	readonly sshControlPath: string;
	readonly appDomain: string;
	readonly gatewayDomain: string;
	readonly publicGatewayUrl: string;
	readonly backendEnvFile: string;
	readonly gatewayEnvFile: string;
	readonly remoteRoot: string;
	readonly historyPath: string;
	readonly caddyConfigPath: string;
	readonly caddyEnvFile: string;
	readonly composeSource: string;
	readonly caddyTemplateSource: string;
	readonly crashAfter: "source-backend-stopped" | "caddy-switched" | null;
}

export interface ProcessResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function timeoutSeconds(timeoutMs: number): number {
	return Math.max(1, Math.ceil(timeoutMs / 1000));
}

async function runProcess(
	argv: readonly string[],
	options: {
		readonly input?: string;
		readonly allowFailure?: boolean;
		readonly timeoutMs?: number;
	} = {},
): Promise<ProcessResult> {
	const child = Bun.spawn([...argv], {
		stdin: options.input === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (options.input !== undefined) {
		if (!child.stdin) throw new Error("process stdin pipe is unavailable");
		child.stdin.write(options.input);
		child.stdin.end();
	}
	const stdoutPromise = new Response(child.stdout).text();
	const stderrPromise = new Response(child.stderr).text();
	const timeoutMs = options.timeoutMs ?? 310_000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const code = await Promise.race([
		child.exited,
		new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), timeoutMs);
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
	if (code === null) {
		child.kill();
		await child.exited.catch(() => {});
		throw new Error(`${argv[0]} timed out after ${timeoutMs}ms`);
	}
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
	const result = { code, stdout, stderr };
	if (code !== 0 && !options.allowFailure) {
		throw new Error(
			`${argv[0]} failed (${code}): ${stderr.trim() || stdout.trim()}`,
		);
	}
	return result;
}

export class RemoteHost {
	readonly #config: SshPromotionConfig;
	readonly #deadlineAt: number;

	constructor(config: SshPromotionConfig, deadlineAt = Date.now() + 300_000) {
		this.#config = config;
		this.#deadlineAt = deadlineAt;
	}

	sshArgs(): string[] {
		return [
			"ssh",
			...(this.#config.sshConfig ? ["-F", this.#config.sshConfig] : []),
			...(this.#config.sshKey ? ["-i", this.#config.sshKey] : []),
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=10",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			"ServerAliveInterval=15",
			"-o",
			"ControlMaster=auto",
			"-o",
			"ControlPersist=60",
			"-o",
			`ControlPath=${this.#config.sshControlPath}`,
			this.#config.sshHost,
		];
	}

	async run(
		command: string,
		options: {
			readonly input?: string;
			readonly allowFailure?: boolean;
			readonly timeoutMs?: number;
		} = {},
	): Promise<ProcessResult> {
		const remainingMs = this.#deadlineAt - Date.now();
		if (remainingMs <= 0) throw new Error("promotion exceeded its time budget");
		const timeoutMs = Math.min(options.timeoutMs ?? remainingMs, remainingMs);
		const bounded =
			`timeout --foreground --signal=TERM --kill-after=5s ` +
			`${timeoutSeconds(timeoutMs)}s sh -c ${shellQuote(command)}`;
		return runProcess([...this.sshArgs(), bounded], {
			...options,
			timeoutMs: Math.min(remainingMs, timeoutMs + 5_000),
		});
	}

	async readOptional(path: string): Promise<string | null> {
		const result = await this.run(
			`if test -f ${shellQuote(path)}; then cat -- ${shellQuote(path)}; fi`,
		);
		return result.stdout.trim() ? result.stdout : null;
	}

	async writeAtomic(
		path: string,
		contents: string,
		mode = "600",
	): Promise<void> {
		const directory = dirname(path);
		const command =
			`umask 077; install -d -m 700 ${shellQuote(directory)}; ` +
			`tmp=$(mktemp ${shellQuote(`${directory}/.useagent-write.XXXXXX`)}); ` +
			`cat > "$tmp"; chmod ${mode} "$tmp"; sync -f "$tmp"; ` +
			`mv -f "$tmp" ${shellQuote(path)}; sync -f ${shellQuote(directory)}`;
		await this.run(command, { input: contents });
	}

	async acquireLock(): Promise<() => Promise<void>> {
		const lockPath = `${this.#config.remoteRoot}/promote.lock`;
		const child = Bun.spawn(
			[
				...this.sshArgs(),
				`install -d -m 700 ${shellQuote(this.#config.remoteRoot)}; ` +
					`flock -n ${shellQuote(lockPath)} sh -c 'printf "LOCKED\\n"; cat >/dev/null'`,
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		const reader = child.stdout.getReader();
		try {
			const marker = (async () => {
				const decoder = new TextDecoder();
				let output = "";
				while (!output.includes("\n")) {
					const chunk = await reader.read();
					if (chunk.done) break;
					output += decoder.decode(chunk.value, { stream: true });
				}
				return output;
			})();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const text = await Promise.race([
				marker,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() =>
							reject(new Error("timed out acquiring remote promotion lock")),
						15_000,
					);
				}),
			]).finally(() => {
				if (timer) clearTimeout(timer);
			});
			if (!text.split("\n").some((line) => line.trim() === "LOCKED")) {
				throw new Error("another promotion owns the remote host lock");
			}
		} catch (error) {
			child.stdin.end();
			child.kill();
			await child.exited.catch(() => {});
			throw error;
		} finally {
			reader.releaseLock();
		}
		return async () => {
			child.stdin.end();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const exited = await Promise.race([
				child.exited.then(() => true),
				new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), 1_000);
				}),
			]).finally(() => {
				if (timer) clearTimeout(timer);
			});
			if (!exited) {
				child.kill();
				await child.exited.catch(() => {});
			}
		};
	}
}
