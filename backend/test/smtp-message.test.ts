import { describe, expect, test } from "bun:test";
import { sendSmtp } from "../src/connectors/email/smtp";

// The wire form of a message: the envelope keeps the bare address, the header
// carries the display name, and an HTML alternative travels next to the text.

async function capture(msg: Parameters<typeof sendSmtp>[1]): Promise<string> {
  let inData = false;
  let data = "";
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.write("220 test\r\n");
      },
      data(s, chunk) {
        const text = chunk.toString();
        if (inData) {
          data += text;
          if (data.includes("\r\n.\r\n")) {
            inData = false;
            s.write("250 queued\r\n");
          }
          return;
        }
        for (const line of text.split("\r\n").filter(Boolean)) {
          if (line.startsWith("DATA")) {
            inData = true;
            s.write("354 go\r\n");
          } else if (line.startsWith("QUIT")) s.write("221 bye\r\n");
          else if (line.startsWith("EHLO")) s.write("250-test\r\n250 OK\r\n");
          else s.write(`250 OK ${line}\r\n`);
        }
      },
    },
  });
  try {
    await sendSmtp({ host: "127.0.0.1", port: server.port, secure: false, timeoutMs: 2_000 }, msg);
  } finally {
    server.stop(true);
  }
  return data;
}

describe("smtp message form", () => {
  test("a display name goes in the From header only, and html rides as a multipart alternative", async () => {
    const wire = await capture({
      from: "noreply@example.test",
      fromName: 'Use"Agent\r\nX-Injected: 1',
      to: ["new@example.test"],
      subject: "hi",
      text: "plain\n.leading dot",
      html: "<p>rich</p>",
    });
    expect(wire).toContain('From: "UseAgentX-Injected: 1" <noreply@example.test>\r\n');
    expect(wire).toMatch(/Content-Type: multipart\/alternative; boundary="[^"]+"\r\n/);
    expect(wire).toContain('Content-Type: text/plain; charset="utf-8"\r\n\r\nplain\r\n..leading dot\r\n');
    expect(wire).toContain('Content-Type: text/html; charset="utf-8"\r\n\r\n<p>rich</p>\r\n');
    expect(wire).toMatch(/--=_useagent_[a-z0-9]+--\r\n\.\r\n$/);
  });

  test("without html the message is plain text with a bare From, as before", async () => {
    const wire = await capture({ from: "noreply@example.test", to: ["new@example.test"], subject: "hi", text: "plain" });
    expect(wire).toContain("From: noreply@example.test\r\n");
    expect(wire).toContain('Content-Type: text/plain; charset="utf-8"\r\n\r\nplain\r\n.\r\n');
    expect(wire).not.toContain("multipart");
  });
});
