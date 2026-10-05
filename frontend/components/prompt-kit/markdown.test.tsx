import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceOpenProvider } from "@/components/chat/workspace-open-context";
import {
  artifactPayloadSupportsWorkspace,
  artifactWorkspaceTarget,
  isSandboxPath,
  Markdown,
} from "./markdown";

describe("Markdown links", () => {
  test("renders downloadable artifacts as compact typed chips", () => {
    const html = renderToStaticMarkup(
      <Markdown>{"[Download report](/api/artifacts/report.pdf)"}</Markdown>,
    );

    expect(html).toContain('href="/api/artifacts/report.pdf"');
    expect(html).toContain("Download report");
    expect(html).toContain(">D<"); // round badge shows the label initial
    expect(html).toContain("rounded-full");
  });

  test("keeps web, protocol-relative, route and anchor links as links", () => {
    for (const href of ["//example.com/report.pdf", "/api/reports/report.pdf", "#report.pdf"]) {
      const html = renderToStaticMarkup(<Markdown>{`[Report](${href})`}</Markdown>);
      expect(html).toContain(`href="${href}"`);
    }
    expect(isSandboxPath("file:///root/work/a.pdf")).toBe(true);
    expect(isSandboxPath("/home/user/work/a.pdf")).toBe(true);
    expect(isSandboxPath("output/report.pdf")).toBe(true);
    expect(isSandboxPath("https://x.test/a.pdf")).toBe(false);
    expect(isSandboxPath("/api/artifacts/a.pdf")).toBe(false);
  });

  test("renders unpublished local files as honest inert chips", () => {
    for (const href of [
      "/home/user/work/report.pdf",
      "output/report.pdf",
      "file:///Users/me/report.pdf",
      "sandbox:/root/work/report.pdf",
      "C:/Users/me/report.pdf",
    ]) {
      const html = renderToStaticMarkup(<Markdown>{`[Download the PDF](${href})`}</Markdown>);
      expect(html).toContain("Download the PDF");
      expect(html).toContain('title="Local file path - not published"');
      expect(html).not.toContain("href=");
      expect(html).not.toContain("Published under Session files");
    }
  });

  test("keeps unsafe schemes inert", () => {
    const html = renderToStaticMarkup(
      <Markdown>{"[Open report](javascript:alert('nope'))"}</Markdown>,
    );
    expect(html).not.toContain("javascript:");
  });

  test("keeps ordinary links on the plain markdown link path", () => {
    const html = renderToStaticMarkup(
      <Markdown>{"[Documentation](https://useagent.org/docs/)"}</Markdown>,
    );

    expect(html).toContain('href="https://useagent.org/docs/"');
    expect(html).not.toContain("rounded-full");
  });

  test("recognizes old and current workpiece preview URLs", () => {
    expect(
      artifactWorkspaceTarget(
        "/api/artifacts/deck%201/content",
        "Preview the Quarterly deck",
        "https://app.useagent.org",
      ),
    ).toEqual({ id: "deck 1", name: "Quarterly deck" });
    expect(
      artifactWorkspaceTarget(
        "https://app.useagent.org/agent/artifacts/sheet-1",
        "Preview Budget.xlsx",
        "https://app.useagent.org",
      ),
    ).toEqual({ id: "sheet-1", name: "Budget.xlsx" });
    expect(
      artifactWorkspaceTarget(
        "https://app.useagent.org/agent/artifacts/deck-1",
        "Open presentation preview",
        "https://app.useagent.org",
      ),
    ).toEqual({ id: "deck-1", name: "presentation" });
    expect(
      artifactWorkspaceTarget(
        "/api/artifacts/deck-1/content?download=1",
        "Preview deck",
        "https://app.useagent.org",
      ),
    ).toBeNull();
    expect(
      artifactWorkspaceTarget(
        "https://evil.example/api/artifacts/deck-1/content",
        "Preview deck",
        "https://app.useagent.org",
      ),
    ).toBeNull();
  });

  test("does not speculate about workspace support before metadata resolves", () => {
    const html = renderToStaticMarkup(
      <WorkspaceOpenProvider value={() => {}}>
        <Markdown>{"[Preview the deck](/api/artifacts/deck-1/content)"}</Markdown>
      </WorkspaceOpenProvider>,
    );

    expect(html).toContain('href="/api/artifacts/deck-1/content"');
    expect(html).toContain('target="_blank"');
  });

  test("uses authoritative artifact metadata for workspace eligibility", () => {
    expect(
      artifactPayloadSupportsWorkspace({ artifact: { workpiece: { kind: "presentation" } } }),
    ).toBe(true);
    expect(
      artifactPayloadSupportsWorkspace({
        artifact: { workpiece: null, preview_pdf_url: "/preview" },
      }),
    ).toBe(true);
    expect(
      artifactPayloadSupportsWorkspace({
        artifact: { content_type: "video/mp4", workpiece: null, preview_pdf_url: null },
      }),
    ).toBe(false);
  });

  test("keeps artifact Download chips as download links inside a session", () => {
    const html = renderToStaticMarkup(
      <WorkspaceOpenProvider value={() => {}}>
        <Markdown>{"[Download the deck](/api/artifacts/deck-1/content?download=1)"}</Markdown>
      </WorkspaceOpenProvider>,
    );

    expect(html).toContain('href="/api/artifacts/deck-1/content?download=1"');
    expect(html).toContain('target="_blank"');
  });
});
