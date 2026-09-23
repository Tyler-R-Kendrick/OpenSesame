import { type LoginItem, createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shareReachSeams } from "../lib/local-share-reach.js";
import { vaultStore } from "../lib/vault/store.js";
import { webmcpNavigationSeam } from "./navigation.js";
import {
  OPEN_REVEAL_TOOL,
  VAULT_TOOLS,
  resetTotpRateLimitForTests,
} from "./vault-tools.js";

function tool(name: string) {
  const found = VAULT_TOOLS.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function loginWithTotp(): LoginItem {
  const item = createItem("login", "Bank");
  item.totp = "JBSWY3DPEHPK3PXP";
  return item;
}

function openVault(items: LoginItem[]): void {
  const snapshot = vaultStore.getSnapshot();
  vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
    ...snapshot,
    status: "unlocked",
    tomb: "personal",
    guest: false,
    items,
  });
  vi.spyOn(vaultStore, "activeTomb").mockReturnValue("personal");
}

/** A member with a session and no share covering anything. */
function memberWithoutShares(): void {
  vi.spyOn(shareReachSeams, "resolveCurrentAccessRole").mockResolvedValue(
    "member",
  );
  vi.spyOn(shareReachSeams, "canAccess").mockReturnValue(false);
  vi.spyOn(shareReachSeams, "currentSession").mockReturnValue({
    principalId: "member-1",
    accessToken: "",
    issuerOrigin: "https://id.example",
  });
  vi.spyOn(shareReachSeams, "listLocalShares").mockResolvedValue([]);
}

describe("item-addressed vault tools honor share reach", () => {
  beforeEach(() => {
    resetTotpRateLimitForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetTotpRateLimitForTests();
  });

  it("refuses a TOTP code for an item outside the actor's shares", async () => {
    const item = loginWithTotp();
    openVault([item]);
    memberWithoutShares();
    await expect(
      tool("opensesame_totp_code").execute({ itemId: item.id }),
    ).rejects.toThrow("share_grant_denied");
  });

  it("does not spend the rate limit on a denied TOTP request", async () => {
    const item = loginWithTotp();
    openVault([item]);
    memberWithoutShares();
    await expect(
      tool("opensesame_totp_code").execute({ itemId: item.id }),
    ).rejects.toThrow("share_grant_denied");
    vi.spyOn(shareReachSeams, "canAccess").mockReturnValue(true);
    const result = await tool("opensesame_totp_code").execute({
      itemId: item.id,
    });
    expect(result).toMatchObject({ itemId: item.id });
  });

  it("still issues a code to an operator", async () => {
    const item = loginWithTotp();
    openVault([item]);
    vi.spyOn(shareReachSeams, "resolveCurrentAccessRole").mockResolvedValue(
      "operator",
    );
    vi.spyOn(shareReachSeams, "canAccess").mockReturnValue(true);
    const result = await tool("opensesame_totp_code").execute({
      itemId: item.id,
    });
    expect(result).toMatchObject({ itemId: item.id });
  });

  it("refuses to open the reveal ceremony for an item outside the shares", async () => {
    const item = loginWithTotp();
    openVault([item]);
    memberWithoutShares();
    const navigate = vi
      .spyOn(webmcpNavigationSeam, "navigate")
      .mockImplementation(() => {});
    await expect(
      Promise.resolve(OPEN_REVEAL_TOOL.execute({ itemId: item.id })),
    ).rejects.toThrow("share_grant_denied");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("refuses a missing id and a real id alike for an unshared member", async () => {
    const item = loginWithTotp();
    openVault([item]);
    memberWithoutShares();
    vi.spyOn(webmcpNavigationSeam, "navigate").mockImplementation(() => {});
    const itemTools = [
      tool("opensesame_vault_item_read"),
      tool("opensesame_vault_item_write"),
      tool("opensesame_totp_code"),
      OPEN_REVEAL_TOOL,
    ];
    for (const entry of itemTools) {
      for (const itemId of [item.id, "no-such-item"]) {
        const args =
          entry.name === "opensesame_vault_item_write"
            ? { itemId, name: "Renamed" }
            : { itemId };
        await expect(Promise.resolve(entry.execute(args))).rejects.toThrow(
          "share_grant_denied",
        );
      }
    }
  });
});
