/**
 * What `ai.password-reset` is in the catalog: its own section, dependent on the
 * login item types, declaring the one request it makes and the one operation it
 * owns (ADR 0190).
 */
import { describe, expect, it } from "vitest";
import { PASSWORD_RESET_MAIL_PURPOSE } from "./catalog-optional-services.js";
import { CAPABILITY_CATALOG } from "./catalog.js";
import { featureById, featureOf } from "./features.js";

const ids = {
  reset: "ai.password-reset",
  itemTypes: "vault.derived-records",
} as const;

const descriptor = (id: string) => {
  const found = CAPABILITY_CATALOG.capabilities.find(
    (entry) => entry.id === id,
  );
  if (!found) throw new Error(`no descriptor for ${id}`);
  return found;
};

describe("the Password reset capability", () => {
  it("is optional and has a section of its own that nothing else shares", () => {
    expect(descriptor(ids.reset).tier).toBe("optional");
    const section = featureById("password-reset");
    expect(section.capabilities).toEqual([ids.reset]);
    expect(featureOf(ids.reset)?.id).toBe("password-reset");
  });

  it("depends on the item types a login and its password are made of", () => {
    expect(descriptor(ids.reset).dependencies).toEqual([ids.itemTypes]);
    const kinds = descriptor(ids.itemTypes).itemKinds;
    expect(kinds).toContain("account");
    expect(kinds).toContain("password");
    expect(descriptor(ids.itemTypes).tier).toBe("optional");
  });

  it("declares one automatic request, to the mail server a person named", () => {
    expect(descriptor(ids.reset).egress).toEqual([
      {
        class: "external-service",
        purpose: PASSWORD_RESET_MAIL_PURPOSE,
        automatic: true,
      },
    ]);
    expect(descriptor(ids.reset).requiresService).toBe(false);
  });

  it("owns mailbox and approved CUA operations, and reads item plaintext", () => {
    expect(descriptor(ids.reset).operationIds).toEqual([
      "password_reset.mailboxes.manage",
      "password_reset.cua.run",
      "password_reset.cua.configure",
    ]);
    expect(descriptor(ids.reset).keyAccess).toBe("item-plaintext");
  });
});
