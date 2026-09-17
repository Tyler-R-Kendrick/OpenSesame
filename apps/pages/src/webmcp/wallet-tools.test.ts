/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { WALLET_TOOLS } from "./wallet-tools.js";

describe("WALLET_TOOLS", () => {
  it("exposes inventory plus scoped propose/status/execute_approved (WAL-B13)", () => {
    const names = WALLET_TOOLS.map((t) => t.name);
    expect(names).toContain("opensesame_wallet_capabilities_read");
    expect(names).toContain("opensesame_wallet_budgets_read");
    expect(names).toContain("opensesame_wallet_allocations_read");
    expect(names).toContain("opensesame_wallet_payment_propose");
    expect(names).toContain("opensesame_wallet_payment_execute_approved");
    expect(names).toContain("opensesame_wallet_payment_status");
    expect(names).toContain("opensesame_wallet_lease_request");
    expect(names).toContain("opensesame_wallet_lease_status");
    expect(names).toContain("opensesame_wallet_lease_request_stop");
    expect(
      names.some((n) =>
        /get_secret|get_card|export_private|unrestricted_sign/i.test(n),
      ),
    ).toBe(false);
  });

  it("capabilities inventory refuses secret and unrestricted spend verbs", () => {
    const tool = WALLET_TOOLS.find(
      (t) => t.name === "opensesame_wallet_capabilities_read",
    );
    if (tool === undefined) {
      throw new Error("missing opensesame_wallet_capabilities_read");
    }
    const result = tool.execute({});
    if (
      typeof result !== "object" ||
      result === null ||
      !("refusals" in result) ||
      !("productionEnabled" in result)
    ) {
      throw new Error("unexpected capabilities payload");
    }
    const refusals = result.refusals;
    if (!Array.isArray(refusals)) {
      throw new Error("refusals must be an array");
    }
    expect(result.productionEnabled).toBe(false);
    for (const verb of [
      "get_secret",
      "get_card_number",
      "export_private_key",
      "unrestricted_sign",
      "unbounded_paid_fetch",
    ]) {
      expect(refusals).toContain(verb);
    }
  });

  it("execute_approved refuses a caller-constructed prepared ref", async () => {
    const tool = WALLET_TOOLS.find(
      (t) => t.name === "opensesame_wallet_payment_execute_approved",
    );
    if (tool === undefined) {
      throw new Error("missing execute_approved tool");
    }
    const result = await tool.execute({
      preparedRef: "prepared:forged",
      singleUseToken: "tok",
    });
    expect(result).toEqual({ ok: false, code: "PREPARED_REF_INVALID" });
  });
});
