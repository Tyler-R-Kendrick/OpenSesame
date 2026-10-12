import { describe, expect, it } from "vitest";
import {
  type OrgVaultOwnerKind,
  formatOrgVaultRef,
  parseOrgVaultRef,
} from "../org-vault-ref.js";

function refusal(
  input: string,
  ownerKind: OrgVaultOwnerKind = "organization",
): string {
  const parsed = parseOrgVaultRef(input, ownerKind);
  if (parsed.ok) throw new Error(`accepted ${input}`);
  return parsed.refusal;
}

describe("OrgVaultRef", () => {
  it("parses owner/slug and refuses a bad spelling", () => {
    const parsed = parseOrgVaultRef("acme/vault", "organization");
    expect(parsed).toEqual({
      ok: true,
      ref: { ownerKind: "organization", owner: "acme", slug: "vault" },
    });
    if (!parsed.ok) return;
    expect(formatOrgVaultRef(parsed.ref)).toBe("acme/vault");
    expect(parseOrgVaultRef("ada/personal", "user").ok).toBe(true);
    expect(parseOrgVaultRef(`${"a".repeat(63)}/b`, "user").ok).toBe(true);
    expect(refusal("")).toBe("empty");
    expect(refusal("acme")).toBe("form");
    expect(refusal("acme/vault/extra")).toBe("form");
    expect(refusal("Acme/vault")).toBe("segment");
    expect(refusal("-acme/vault")).toBe("segment");
    expect(refusal(`${"a".repeat(64)}/b`)).toBe("segment");
    expect(refusal("acme/guest")).toBe("reserved");
    expect(refusal("guest/vault", "user")).toBe("reserved");
  });
});
