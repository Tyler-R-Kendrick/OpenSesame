import { describe, expect, it } from "vitest";
import { generatePaymentApprovalKeyPair } from "./keys.js";
import { redactWalletExport, walletExportLeaksCanary } from "./redact.js";

describe("redactWalletExport (WAL-B17)", () => {
  it("strips a seeded canary from a status/receipt export", () => {
    const canary = "CANARY_wallet_parent_root_key_material";
    const keys = generatePaymentApprovalKeyPair();
    const leaked = {
      status: "local_ledger",
      destination: canary,
      proofHex: Buffer.from(keys.privateKeyPkcs8).toString("hex"),
    };
    const exported = redactWalletExport(leaked);
    expect(walletExportLeaksCanary(exported, [canary])).toBe(false);
    expect(exported).not.toContain(canary);
    expect(exported).not.toContain(leaked.proofHex);
    expect(exported).toContain("[redacted-canary]");
    expect(exported).toContain("[redacted-hex]");
  });
});

describe("a wallet export carries no credential by shape (ADR 0155)", () => {
  it("scrubs a bearer, a JWT and a secret URL parameter", () => {
    const exported = redactWalletExport({
      note: "sent Authorization: Bearer abc.def.ghi",
      link: "https://pay.example/cb?code=abc123&page=2",
      jwt: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
    });
    expect(exported).not.toMatch(/abc\.def\.ghi|abc123|eyJhbGci/);
    expect(exported).toContain("page=2");
  });
});
