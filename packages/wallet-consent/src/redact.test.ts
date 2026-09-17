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
