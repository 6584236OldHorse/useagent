import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { GithubAppConfig } from "../env";
import {
	clearInstallationTokenCache,
	getRepositoryInstallationTokenForId,
	getRepositoryPublicationTokenForId,
} from "./app-auth";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	clearInstallationTokenCache();
});

describe("GitHub repository installation token permissions", () => {
	test("caches read and publication credentials separately with least privilege", async () => {
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
		const config: GithubAppConfig = {
			appId: "4689651",
			privateKey: privateKey
				.export({ type: "pkcs8", format: "pem" })
				.toString(),
			org: null,
		};
		const requests: Array<Record<string, unknown>> = [];
		globalThis.fetch = (async (_input, init) => {
			requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return Response.json({
				token: `installation-token-${requests.length}`,
				expires_at: "2099-01-01T00:00:00.000Z",
			});
		}) as typeof fetch;

		const read = await getRepositoryInstallationTokenForId(
			"acme/widget",
			123,
			config,
		);
		const cachedRead = await getRepositoryInstallationTokenForId(
			"acme/widget",
			123,
			config,
		);
		const publication = await getRepositoryPublicationTokenForId(
			"acme/widget",
			123,
			config,
		);

		expect(read.token).toBe("installation-token-1");
		expect(cachedRead.token).toBe(read.token);
		expect(publication.token).toBe("installation-token-2");
		expect(requests).toEqual([
			{
				repositories: ["widget"],
				permissions: { contents: "read", metadata: "read" },
			},
			{
				repositories: ["widget"],
				permissions: {
					contents: "write",
					metadata: "read",
					pull_requests: "write",
				},
			},
		]);
	});
});

describe("GitHub App token mint refusals", () => {
	test("a 422 on a publication mint names the permissions the App lacks", async () => {
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
		const config: GithubAppConfig = {
			appId: "4689651",
			privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
			org: null,
		};
		globalThis.fetch = (async (_input, _init) =>
			Response.json({ message: "Validation Failed" }, { status: 422 })) as typeof fetch;

		await expect(getRepositoryPublicationTokenForId("acme/widget", 123, config)).rejects.toThrow(
			/HTTP 422 \(Validation Failed\); this usually means the App or its installation lacks one of the requested permissions \(contents:write, metadata:read, pull_requests:write\)/,
		);
	});

	test("other refusals keep the bare status", async () => {
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
		const config: GithubAppConfig = {
			appId: "4689651",
			privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
			org: null,
		};
		globalThis.fetch = (async (_input, _init) => new Response("nope", { status: 401 })) as typeof fetch;

		await expect(getRepositoryInstallationTokenForId("acme/widget", 123, config)).rejects.toThrow(
			/HTTP 401$/,
		);
	});
});
