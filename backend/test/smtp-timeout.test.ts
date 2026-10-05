import { describe, expect, test } from "bun:test";
import { sendSmtp } from "../src/connectors/email/smtp";

// The SMTP client must give up on a relay that never speaks or hangs up, and
// close its socket when it does, so a stalled invitation cannot pile up
// connections behind a request that already returned.

const message = { from: "hello@example.test", to: ["new@example.test"], subject: "hi", text: "body" };

describe("smtp client bounds", () => {
  test("a relay that never greets times out and the socket is closed", async () => {
    let opened = 0;
    let closed = 0;
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {
          opened += 1; // say nothing
        },
        data() {},
        close() {
          closed += 1;
        },
      },
    });
    try {
      const started = Date.now();
      await expect(
        sendSmtp({ host: "127.0.0.1", port: server.port, secure: false, timeoutMs: 150 }, message),
      ).rejects.toThrow("SMTP timeout");
      expect(Date.now() - started).toBeLessThan(2_000);
      for (let i = 0; i < 20 && closed < opened; i += 1) await Bun.sleep(25);
      expect(opened).toBe(1);
      expect(closed).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("a relay that never accepts the connection times out too", async () => {
    // A non-routable address: the connect attempt hangs until the deadline.
    const started = Date.now();
    await expect(
      sendSmtp({ host: "10.255.255.1", port: 25, secure: false, timeoutMs: 200 }, message),
    ).rejects.toThrow("SMTP timeout");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("a relay that hangs up mid-dialog fails the send instead of parking it", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.write("220 ready\r\n");
        },
        data(socket) {
          socket.end(); // hang up on EHLO
        },
      },
    });
    try {
      await expect(
        sendSmtp({ host: "127.0.0.1", port: server.port, secure: false, timeoutMs: 2_000 }, message),
      ).rejects.toThrow("SMTP connection closed");
    } finally {
      server.stop(true);
    }
  });
});
