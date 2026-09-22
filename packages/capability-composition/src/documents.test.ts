import { describe, expect, it } from "vitest";
import {
  validateInstallationSelection,
  validateInstancePolicy,
  validateVaultRestriction,
} from "./documents.js";
import { policy, selection, vaultRestriction } from "./test-helpers.js";

describe("instance policy validator", () => {
  it("accepts a well-formed policy", () => {
    expect(validateInstancePolicy(policy()).ok).toBe(true);
  });

  it("rejects unknown fields", () => {
    const result = validateInstancePolicy(policy({ autoGrantAll: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.field === "autoGrantAll")).toBe(
        true,
      );
    }
  });

  it("rejects wrong kind or schemaVersion", () => {
    expect(
      validateInstancePolicy(policy({ kind: "vault-restriction" })).ok,
    ).toBe(false);
    expect(validateInstancePolicy(policy({ schemaVersion: 2 })).ok).toBe(false);
  });

  it("rejects malformed capability ids and de-duplicates valid ones", () => {
    const result = validateInstancePolicy(
      policy({ required: ["good.id", "good.id"], optional: ["bad id!"] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.failures.some((f) => f.problem === "malformed capability id"),
      ).toBe(true);
    }
    const clean = validateInstancePolicy(
      policy({ required: ["good.id", "good.id"] }),
    );
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.document.required).toEqual(["good.id"]);
  });

  it("rejects malformed network and updates blocks", () => {
    expect(
      validateInstancePolicy(policy({ network: { externalServices: "maybe" } }))
        .ok,
    ).toBe(false);
    expect(
      validateInstancePolicy(
        policy({ updates: { unknownCapabilities: "ignore" } }),
      ).ok,
    ).toBe(false);
  });
});

describe("allow-set semantics", () => {
  it("treats absent allow as inherit", () => {
    const result = validateVaultRestriction(
      vaultRestriction({ allow: undefined }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.allow).toBe("inherit");
  });

  it("accepts inherit explicitly", () => {
    const result = validateVaultRestriction(
      vaultRestriction({ allow: "inherit" }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts an explicit empty ids array (allow none)", () => {
    const result = validateVaultRestriction(
      vaultRestriction({ allow: { ids: [] } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.allow).toEqual({ ids: [] });
  });

  it("rejects junk allow values", () => {
    expect(validateVaultRestriction(vaultRestriction({ allow: {} })).ok).toBe(
      false,
    );
    expect(validateVaultRestriction(vaultRestriction({ allow: 7 })).ok).toBe(
      false,
    );
    expect(
      validateVaultRestriction(vaultRestriction({ allow: { ids: "x" } })).ok,
    ).toBe(false);
  });
});

describe("installation selection validator", () => {
  it("accepts a well-formed selection", () => {
    expect(validateInstallationSelection(selection())).ok.toBeTruthy();
  });

  it("allows a null vaultId for instance-wide selections", () => {
    const result = validateInstallationSelection(selection({ vaultId: null }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.vaultId).toBeNull();
  });

  it("rejects unknown fields", () => {
    const result = validateInstallationSelection(selection({ grant: "*" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a bad vaultIdSource", () => {
    expect(
      validateInstallationSelection(selection({ vaultIdSource: "guess" })).ok,
    ).toBe(false);
  });
});
