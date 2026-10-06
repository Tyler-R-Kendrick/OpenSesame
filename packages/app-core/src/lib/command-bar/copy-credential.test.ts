import type { VaultItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { plainAccount } from "../account.test-support.js";
import { type CommandPorts, executeCommand } from "./execute.js";

const portsFor = (
  items: readonly VaultItem[],
  copied: string[],
): CommandPorts => ({
  navigate: () => undefined,
  copy: async (value) => {
    copied.push(value);
    return "copied";
  },
  items: () => items,
  vaultLocked: () => false,
});

describe("executeCommand copy_field for an account with no password", () => {
  it("copies an API key's header line when the account has no password, and says nothing is there for an empty one", async () => {
    const base = plainAccount("Billing", "unused");
    const keyed = (key: string): VaultItem => ({
      ...base,
      methods: [{ id: "k", type: "api-key", key, header: "X-Api-Key" }],
    });
    const copied: string[] = [];
    const done = await executeCommand(
      { action: "copy_field", field: "password", query: "bill" },
      portsFor([keyed("ak_9")], copied),
    );
    expect(done).toEqual({ ok: true, message: "Copied password for Billing" });
    expect(copied).toEqual(["X-Api-Key: ak_9"]);

    const none = await executeCommand(
      { action: "copy_field", field: "password", query: "bill" },
      portsFor([keyed("")], copied),
    );
    expect(none).toEqual({
      ok: false,
      message: "Billing has no password to copy.",
    });
    const rest = await executeCommand(
      { action: "copy_field", field: "rest", query: "bill" },
      portsFor([keyed("ak_9")], copied),
    );
    expect(rest.ok).toBe(false);
    expect(copied).toEqual(["X-Api-Key: ak_9"]);
  });
});
