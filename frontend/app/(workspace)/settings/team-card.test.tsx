import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canManageTeam, invitationHref, memberRole, type TeamMember } from "./team-api";
import { TeamCard, assignableRoles, canEditMember } from "./team-card";

const member = (over: Partial<TeamMember>): TeamMember => ({
  id: "m1",
  userId: "u1",
  name: "Dana",
  email: "dana@example.test",
  image: null,
  role: "member",
  joinedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

describe("team roles", () => {
  test("the first stored role is the rank, and anything unknown is a member", () => {
    expect(memberRole("owner")).toBe("owner");
    expect(memberRole("admin,member")).toBe("admin");
    expect(memberRole("editor")).toBe("member");
    expect(memberRole(undefined)).toBe("member");
  });

  test("owners and admins manage people; only an owner hands out ownership", () => {
    expect(canManageTeam("owner")).toBe(true);
    expect(canManageTeam("admin")).toBe(true);
    expect(canManageTeam("member")).toBe(false);
    expect(canManageTeam(null)).toBe(false);
    expect(assignableRoles("owner")).toEqual(["owner", "admin", "member"]);
    expect(assignableRoles("admin")).toEqual(["admin", "member"]);
  });

  test("nobody edits themselves, and an admin cannot touch an owner", () => {
    expect(canEditMember("admin", "u9", member({}))).toBe(true);
    expect(canEditMember("admin", "u1", member({}))).toBe(false);
    expect(canEditMember("admin", "u9", member({ role: "owner" }))).toBe(false);
    expect(canEditMember("owner", "u9", member({ role: "owner" }))).toBe(true);
    expect(canEditMember("member", "u9", member({}))).toBe(false);
  });

  test("the invitation link points at the accept page on this origin", () => {
    expect(invitationHref("inv 1", "https://app.example.test")).toBe(
      "https://app.example.test/accept-invitation/inv%201",
    );
  });
});

test("the card renders its loading state before any client effect runs", () => {
  const html = renderToStaticMarkup(createElement(TeamCard));
  expect(html).toContain("Loading members...");
  expect(html).not.toContain(">Invite<");
});
