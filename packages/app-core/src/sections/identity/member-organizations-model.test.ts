import { describe, expect, it } from "vitest";
import { LocalDirectoryError } from "../../lib/local-directory-types.js";
import {
  memberListStatus,
  memberRowKeys,
  organizationListStatus,
  settleOrganizationCall,
} from "./member-organizations-model.js";

const person = (role: "owner" | "admin" | "member", name = "Ada") => ({
  principalId: `id-${name}`,
  role,
  kind: "person" as const,
  name,
});

describe("memberRowKeys", () => {
  it("gives an owner every role on a person and removal of anyone", () => {
    for (const role of ["owner", "admin", "member"] as const)
      expect(memberRowKeys("passkey", "owner", person(role))).toEqual({
        roles: ["member", "admin", "owner"],
        remove: true,
      });
  });

  it("never offers an owner a privileged role for an agent or a guest", () => {
    expect(
      memberRowKeys("passkey", "owner", {
        principalId: "agent-1",
        role: "member",
        kind: "agent",
        name: "Build bot",
      }),
    ).toEqual({ roles: [], remove: true });
    expect(
      memberRowKeys("passkey", "owner", person("member", "Guest 2")),
    ).toEqual({ roles: [], remove: true });
  });

  it("lets an admin remove ordinary members and touch no admin or owner", () => {
    expect(memberRowKeys("passkey", "admin", person("member"))).toEqual({
      roles: [],
      remove: true,
    });
    for (const role of ["admin", "owner"] as const)
      expect(memberRowKeys("passkey", "admin", person(role))).toEqual({
        roles: [],
        remove: false,
      });
  });

  it("keeps a member and every agent-key session read-only", () => {
    expect(memberRowKeys("passkey", "member", person("member"))).toEqual({
      roles: [],
      remove: false,
    });
    for (const role of ["owner", "admin", "member"] as const)
      expect(memberRowKeys("agent_key", role, person("member"))).toEqual({
        roles: [],
        remove: false,
      });
  });
});

describe("organization status sentences", () => {
  it("carries the library's refusal and hides anything else", async () => {
    expect(
      await settleOrganizationCall(
        Promise.reject(
          new LocalDirectoryError("This organization is unavailable."),
        ),
      ),
    ).toEqual({ ok: false, refusal: "This organization is unavailable." });
    expect(
      await settleOrganizationCall(
        Promise.reject(new Error("disk said no: /secret/path")),
      ),
    ).toEqual({
      ok: false,
      refusal:
        "The organization change did not complete. Unlock the vault and retry.",
    });
    expect(await settleOrganizationCall(Promise.resolve(3))).toEqual({
      ok: true,
      value: 3,
    });
  });

  it("distinguishes loading, empty, listed and failed", () => {
    expect(organizationListStatus(null, "")).toEqual({
      tone: "idle",
      label: "Loading organizations…",
    });
    expect(organizationListStatus(0, "")).toEqual({
      tone: "idle",
      label: "Not a member of any organization.",
    });
    expect(organizationListStatus(1, "").label).toBe(
      "Member of 1 organization.",
    );
    expect(organizationListStatus(2, "").label).toBe(
      "Member of 2 organizations.",
    );
    expect(organizationListStatus(1, "Refused.")).toEqual({
      tone: "err",
      label: "Refused.",
    });
  });

  it("names a member list's state", () => {
    expect(memberListStatus(null, "", false).label).toBe("Loading members…");
    expect(memberListStatus(1, "", false).label).toBe("1 member.");
    expect(memberListStatus(3, "", false).label).toBe("3 members.");
    expect(memberListStatus(1, "", true).label).toBe(
      "Complete the membership change…",
    );
    expect(memberListStatus(1, "Refused.", true)).toEqual({
      tone: "err",
      label: "Refused.",
    });
  });
});
