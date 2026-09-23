import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerLegacyJumps,
  registerLegacyTabPaths,
} from "../lib/contributions.test-support.js";
import { shareReachSeams } from "../lib/local-share-reach.js";
import { vaultStore } from "../lib/vault/store.js";
import {
  navigationPaths,
  navigationTool,
  webmcpNavigationSeam,
} from "./navigation.js";

const original = webmcpNavigationSeam.navigate;
/**
 * Sections and their tabs are `command-path` contributions now, so the tool's
 * destination table is whatever the approved capabilities registered: the
 * five section paths from each section's owner, and one tab path per tab
 * from the capability that draws it. This suite registers what a full plan's
 * modules do. Nothing registered is the other end of the same contract — the
 * refusal cases below rely on it, and an excluded capability's section is
 * then not a destination at all.
 */
let revokes: readonly (() => void)[] = [];
beforeEach(() => {
  revokes = [registerLegacyJumps(), registerLegacyTabPaths()];
});
afterEach(() => {
  for (const revoke of revokes) revoke();
  revokes = [];
  webmcpNavigationSeam.navigate = original;
});

describe("WebMCP navigation", () => {
  it("opens validated public prefills without allowing secrets or automatic submission", async () => {
    const navigate = vi.fn();
    webmcpNavigationSeam.navigate = navigate;
    await navigationTool.execute({
      section: "/vault/new",
      itemType: "login",
      prefill: {
        name: "Example",
        username: "public_alias",
        uri: "https://example.com",
      },
    });
    expect(navigate).toHaveBeenCalledWith(
      "/vault/new/login?name=Example&username=public_alias&uri=https%3A%2F%2Fexample.com",
    );
    for (const prefill of [
      { password: "sentinel" },
      { submit: "true" },
      { uri: "https://example.com?token=sentinel" },
      { name: 5 },
    ]) {
      await expect(
        navigationTool.execute({ section: "/vault/new", prefill }),
      ).rejects.toThrow("invalid_prefill");
    }
    await expect(
      navigationTool.execute({ section: "/settings", prefill: { name: "no" } }),
    ).rejects.toThrow("invalid_prefill");
    expect(navigate).toHaveBeenCalledOnce();
  });
  it("opens every authored destination, including real section tabs", async () => {
    const navigate = vi.fn();
    webmcpNavigationSeam.navigate = navigate;
    for (const section of navigationPaths()) {
      await navigationTool.execute({ section });
      expect(navigate).toHaveBeenLastCalledWith(section);
    }
    expect(navigationPaths()).toContain("/access?view=requests");
    expect(navigationPaths()).toContain("/identity?view=devices");
    expect(navigationPaths()).toContain("/settings/security");
  });

  it.each([
    "https://attacker.invalid",
    "//attacker.invalid",
    "/vault/../settings",
    "/vault?token=abc",
    "/settings/nope",
  ])("refuses unrecognized destination %s", async (section) => {
    await expect(navigationTool.execute({ section })).rejects.toThrow(
      "unknown_section",
    );
  });

  it("locks the ceremony to an installed type and refuses invalid types", async () => {
    const navigate = vi.fn();
    webmcpNavigationSeam.navigate = navigate;
    await navigationTool.execute({ section: "/vault/new", itemType: "login" });
    expect(navigate).toHaveBeenCalledWith("/vault/new/login");
    await expect(
      navigationTool.execute({
        section: "/vault/new",
        itemType: "not-installed",
      }),
    ).rejects.toThrow("invalid_item_type_destination");
    await expect(
      navigationTool.execute({ section: "/settings", itemType: "login" }),
    ).rejects.toThrow("invalid_item_type_destination");
  });

  it("refuses unknown item routes and edit without an item", async () => {
    await expect(
      navigationTool.execute({
        section: "/vault",
        itemId: "missing",
        edit: true,
      }),
    ).rejects.toThrow("invalid_item_destination");
    await expect(
      navigationTool.execute({ section: "/vault", edit: true }),
    ).rejects.toThrow("edit_requires_item");
  });

  describe("item routes honor share reach", () => {
    const item = createItem("login", "Bank");

    beforeEach(() => {
      const snapshot = vaultStore.getSnapshot();
      vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
        ...snapshot,
        status: "unlocked",
        tomb: "personal",
        guest: false,
        items: [item],
      });
      vi.spyOn(vaultStore, "activeTomb").mockReturnValue("personal");
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

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

    it("denies a member with no share, for real and unknown ids alike", async () => {
      memberWithoutShares();
      const navigate = vi.fn();
      webmcpNavigationSeam.navigate = navigate;
      for (const itemId of [item.id, "missing"]) {
        for (const edit of [false, true]) {
          await expect(
            navigationTool.execute({ section: "/vault", itemId, edit }),
          ).rejects.toThrow("share_grant_denied");
        }
      }
      expect(navigate).not.toHaveBeenCalled();
    });

    it("opens the item for an operator", async () => {
      vi.spyOn(shareReachSeams, "resolveCurrentAccessRole").mockResolvedValue(
        "operator",
      );
      vi.spyOn(shareReachSeams, "canAccess").mockReturnValue(true);
      const navigate = vi.fn();
      webmcpNavigationSeam.navigate = navigate;
      await navigationTool.execute({ section: "/vault", itemId: item.id });
      expect(navigate).toHaveBeenCalledWith(`/vault/${item.id}`);
    });
  });
});
