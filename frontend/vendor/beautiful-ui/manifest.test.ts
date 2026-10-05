import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ComponentRecord = {
  slug: string;
  intendedFilename: string;
  vendoredPath: string;
  rscRecordId?: string;
  sourceUrl?: string;
  upstreamCommit?: string;
  registryPath?: string;
  bytes: number;
  sha256: string;
  imports: string[];
};

type Manifest = {
  upstream: {
    sourceUrl: string;
    licenseUrl: string;
    fetchedAtUtc: string;
    nextBuildId: string;
    vercelDeploymentId: string;
    staticSourceSnapshot: Record<string, string>;
  };
  license: { file: string; sha256: string };
  componentCount: number;
  unresolvedUpstreamImports: string[];
  components: ComponentRecord[];
};

const vendorRoot = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  await readFile(resolve(vendorRoot, "manifest.json"), "utf8"),
) as Manifest;

const sha256 = (content: Uint8Array) => createHash("sha256").update(content).digest("hex");

describe("Beautiful UI vendor snapshot", () => {
  test("pins all 21 component sources with their upstream provenance", () => {
    expect(manifest.componentCount).toBe(21);
    expect(manifest.components).toHaveLength(manifest.componentCount);
    expect(new Set(manifest.components.map(({ slug }) => slug)).size).toBe(21);
    const rscRecords = manifest.components.filter(({ rscRecordId }) => rscRecordId);
    expect(rscRecords).toHaveLength(20);
    expect(new Set(rscRecords.map(({ rscRecordId }) => rscRecordId)).size).toBe(20);
    const flowchart = manifest.components.find(({ slug }) => slug === "flowchart");
    expect(flowchart?.upstreamCommit).toBe("ff0f74d62d8be9d89bcb735b3632e31a6ccf88dc");
    expect(flowchart?.sourceUrl).toBe(
      `https://github.com/slev12397/beautiful-ui/blob/${flowchart?.upstreamCommit}/public/r/flowchart.json`,
    );
    expect(flowchart?.registryPath).toBe("components/primitives/Flowchart.tsx");

    expect(manifest.upstream.sourceUrl).toBe("https://www.beautifului.dev/");
    expect(manifest.upstream.licenseUrl).toBe("https://www.beautifului.dev/license");
    expect(manifest.upstream.fetchedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(manifest.upstream.nextBuildId).not.toBeEmpty();
    expect(manifest.upstream.vercelDeploymentId).toMatch(/^dpl_[A-Za-z0-9]+$/);
    expect(Object.values(manifest.upstream.staticSourceSnapshot).every(Boolean)).toBe(true);

    // react and react-dom resolve in this frontend; everything else upstream
    // imports is a site-local atom or a package we did not adopt.
    const resolved = new Set(["react", "react-dom"]);
    const unresolvedImports = new Set(
      manifest.components.flatMap(({ imports }) => imports).filter((name) => !resolved.has(name)),
    );
    expect(manifest.unresolvedUpstreamImports.toSorted()).toEqual(
      [...unresolvedImports].toSorted(),
    );
  });

  test("matches every listed source by path, byte count, and SHA-256", async () => {
    const actualFiles = (await readdir(resolve(vendorRoot, "sources"))).toSorted();
    const expectedFiles = manifest.components
      .map(({ vendoredPath }) => vendoredPath.replace(/^sources\//, ""))
      .toSorted();
    expect(actualFiles).toEqual(expectedFiles);

    for (const component of manifest.components) {
      expect(component.vendoredPath).toBe(`sources/${component.intendedFilename}.txt`);
      const content = await readFile(resolve(vendorRoot, component.vendoredPath));
      expect(content.byteLength).toBe(component.bytes);
      expect(sha256(content)).toBe(component.sha256);
      expect(content.toString("utf8").startsWith('"use client";')).toBe(true);
      expect(content.toString("utf8")).toContain("export default");
    }
  });

  test("preserves the complete published MIT license", async () => {
    const license = await readFile(resolve(vendorRoot, manifest.license.file));
    const text = license.toString("utf8");

    expect(sha256(license)).toBe(manifest.license.sha256);
    expect(text).toStartWith("MIT License\n\nCopyright (c) 2026 Shane Levine\n\n");
    expect(text).toContain(
      "The above copyright notice and this permission notice shall be included",
    );
    expect(text).toEndWith("SOFTWARE.");
  });
});
