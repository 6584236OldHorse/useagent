import { describe, expect, test } from "bun:test";
import { retainedSandboxReservationTtlMs } from "./lease-repo";

describe("retained sandbox reservation window", () => {
  test("follows the provider's auto-delete window by default", () => {
    expect(retainedSandboxReservationTtlMs({})).toBe(4_320 * 60_000);
    expect(retainedSandboxReservationTtlMs({ SANDBOX_AUTO_DELETE_MIN: "90" })).toBe(90 * 60_000);
  });

  test("can be shortened on its own for a provider that pauses idle sandboxes", () => {
    expect(retainedSandboxReservationTtlMs({ SANDBOX_AUTO_DELETE_MIN: "4320", FLEET_RETAINED_RESERVATION_MIN: "60" })).toBe(60 * 60_000);
  });

  test("ignores a value that is not a positive number, falling back one variable at a time", () => {
    expect(retainedSandboxReservationTtlMs({ FLEET_RETAINED_RESERVATION_MIN: "soon" })).toBe(4_320 * 60_000);
    expect(retainedSandboxReservationTtlMs({ FLEET_RETAINED_RESERVATION_MIN: "0" })).toBe(4_320 * 60_000);
    expect(retainedSandboxReservationTtlMs({ SANDBOX_AUTO_DELETE_MIN: "90", FLEET_RETAINED_RESERVATION_MIN: "soon" })).toBe(90 * 60_000);
  });

  test("never reserves longer than the reuse window", () => {
    expect(retainedSandboxReservationTtlMs({ SANDBOX_AUTO_DELETE_MIN: "90", FLEET_RETAINED_RESERVATION_MIN: "600" })).toBe(90 * 60_000);
  });
});
