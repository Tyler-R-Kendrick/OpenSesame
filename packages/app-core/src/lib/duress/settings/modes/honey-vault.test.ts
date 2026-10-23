import type { VaultItem } from "@opensesame/vault-core";
import { describe, expect, it, vi } from "vitest";
import { mintHoneyToken } from "../../../honey-tokens.js";
import { hasEffectRunner, runDuressEffects } from "./effects.js";
import { HONEY_VAULT, honeyVaultRecords } from "./honey-vault.js";
import { decodePlan, encodePlan } from "./payload.js";

const plan = () => HONEY_VAULT.plan();

describe("HoneyVault mode", () => {
  it("seals six distinct synthetic credentials that survive the slot codec", () => {
    const built = plan();
    const records = honeyVaultRecords(built.body);
    expect(records).toHaveLength(6);
    expect(new Set(records.map((row) => row.token)).size).toBe(6);
    expect(records.every((row) => row.token.startsWith("osr_"))).toBe(true);
    expect(decodePlan(encodePlan(built))).toEqual(built);
    expect(hasEffectRunner("honey_vault")).toBe(true);
  });

  it("puts the credentials into the ephemeral decoy as accounts", async () => {
    const addItems = vi.fn(async (_items: VaultItem[]) => undefined);
    await runDuressEffects(plan(), "after_session", {
      store: { addItems },
    });
    expect(addItems).toHaveBeenCalledTimes(1);
    const items = addItems.mock.calls[0]?.[0] ?? [];
    expect(items).toHaveLength(6);
    expect(
      items.every(
        (item) =>
          item.kind === "account" &&
          item.methods[0]?.type === "password" &&
          String(item.methods[0].secret).startsWith("osr_"),
      ),
    ).toBe(true);
  });

  it("rejects forged records instead of adding a malformed token", () => {
    expect(
      honeyVaultRecords({
        v: 1,
        items: [{ title: "x", token: `${mintHoneyToken().token}x` }],
      }),
    ).toEqual([]);
  });
});
