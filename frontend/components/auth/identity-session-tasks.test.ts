import { describe, expect, test } from "bun:test";
import {
  hasPendingMfaRecoveryAcknowledgement,
  mfaRecoveryDestination,
  sessionTaskDestination,
  shouldFetchNextOrganizationPage,
  signOutBeforeClearingRecoveryMarker,
  verifyTotpWithPendingRecoveryAcknowledgement,
} from "./identity-session-tasks";

test("failed sign-out cannot remove a persisted recovery marker", async () => {
  let markerPresent = true;
  await expect(
    signOutBeforeClearingRecoveryMarker(
      async () => {
        throw new Error("response lost");
      },
      () => {
        markerPresent = false;
      },
    ),
  ).rejects.toThrow("response lost");
  expect(markerPresent).toBeTrue();
  await signOutBeforeClearingRecoveryMarker(
    async () => undefined,
    () => {
      markerPresent = false;
    },
  );
  expect(markerPresent).toBeFalse();
});

describe("sessionTaskDestination", () => {
  test("routes a remaining task instead of entering the app", () => {
    expect(
      sessionTaskDestination(
        { status: "pending", currentTask: { key: "setup-mfa" } },
        "/dashboard?view=mine",
      ),
    ).toBe("/login/tasks/setup-mfa?redirect_url=%2Fdashboard%3Fview%3Dmine");
    expect(sessionTaskDestination({ status: "active" }, "/dashboard?view=mine")).toBe(
      "/dashboard?view=mine",
    );
    expect(sessionTaskDestination({ status: "pending" }, "/dashboard")).toBeNull();
  });
});

test("failed organization pagination waits for an explicit retry", () => {
  expect(
    shouldFetchNextOrganizationPage({
      taskKey: "choose-organization",
      loaded: true,
      hasNextPage: true,
      isFetching: false,
      isError: true,
    }),
  ).toBeFalse();
});

test("recovery codes require acknowledgement before entering the app", () => {
  const active = { status: "active" };
  expect(mfaRecoveryDestination(active, "/dashboard", false)).toBeNull();
  expect(mfaRecoveryDestination(active, "/dashboard", true)).toBe("/dashboard");
});

test("a refresh marker keeps recovery acknowledgement pending", () => {
  const stored = new Map([["useagent:mfa-recovery-ack:sess_1", "pending"]]);
  const pending = hasPendingMfaRecoveryAcknowledgement("sess_1", (key) => stored.get(key) ?? null);
  expect(pending).toBeTrue();
  expect(mfaRecoveryDestination({ status: "active" }, "/dashboard", !pending)).toBeNull();
  expect(
    hasPendingMfaRecoveryAcknowledgement("sess_2", (key) => stored.get(key) ?? null),
  ).toBeFalse();
});

test("MFA verification starts only after the recovery marker is stored", async () => {
  let verified = false;
  await expect(
    verifyTotpWithPendingRecoveryAcknowledgement({
      markPending: () => {
        throw new Error("storage unavailable");
      },
      verify: async () => {
        verified = true;
      },
    }),
  ).rejects.toThrow("storage unavailable");
  expect(verified).toBeFalse();
});

test("an uncertain verification response leaves the recovery marker intact", async () => {
  let marker = false;
  await expect(
    verifyTotpWithPendingRecoveryAcknowledgement({
      markPending: () => {
        marker = true;
      },
      verify: async () => {
        throw new Error("response lost");
      },
    }),
  ).rejects.toThrow("response lost");
  expect(marker).toBeTrue();
});
