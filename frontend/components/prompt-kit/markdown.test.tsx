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

  test("a sandbox path of any file type never becomes a link inside a session", () => {
    for (const href of ["/root/work/notes.md", "/home/user/work/page.html", "out/chart.svg"]) {
      const html = renderToStaticMarkup(
        <WorkspaceOpenProvider value={() => {}}>
          <Markdown>{`[Report](${href})`}</Markdown>
        </WorkspaceOpenProvider>,
      );
      expect(html).not.toContain("href=");
      expect(html).toContain("Report");
    }
  });

  test("a file: link loses its dead anchor and keeps its text", () => {
    const html = renderToStaticMarkup(<Markdown>{"[Report](file:///root/work/a.pdf)"}</Markdown>);
    expect(html).toContain("Report");
    expect(html).not.toContain("<a");
  });

  test("renders a sandbox path as a named chip, never as a dead link", () => {
    const html = renderToStaticMarkup(
      <WorkspaceOpenProvider value={() => {}}>
        <Markdown>{"[Download the PDF](/home/user/work/report.pdf)"}</Markdown>
      </WorkspaceOpenProvider>,
    );
    expect(html).toContain("Download the PDF");
    expect(html).not.toContain("href=");
    expect(html).toContain("workspace");
  });

  test("a workspace path that is not a deliverable keeps its ordinary anchor, and formatted labels survive", () => {
    expect(isSandboxPath("/root/work/data.json")).toBe(false);
    expect(isSandboxPath("src/index.ts")).toBe(false);
    const html = renderToStaticMarkup(
      <WorkspaceOpenProvider value={() => {}}>
        <Markdown>{"[**Quarterly notes**](output/notes.md)"}</Markdown>
      </WorkspaceOpenProvider>,
    );
    expect(html).toContain("<strong>Quarterly notes</strong>");
    expect(html).not.toContain("href=");
    expect(html).not.toContain(">Open<");
  });

  test("outside a session, such as a wiki page, a relative file link stays a link", () => {
    const html = renderToStaticMarkup(<Markdown>{"[README.md](README.md)"}</Markdown>);
    expect(html).toContain('href="README.md"');
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
