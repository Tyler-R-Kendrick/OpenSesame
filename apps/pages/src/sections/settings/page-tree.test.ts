import { FEATURES } from "@opensesame/app-core/lib/capabilities/features.js";
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import { describe, expect, it } from "vitest";
import {
  capabilitiesSettingsSections,
  settingsPageSources,
  settingsPageTree,
} from "./page-tree.js";

const SEALED_STORE = {
  id: "sealed-store",
  label: "Sealed store",
  category: "vaults",
  order: 50,
};
const FORMATS = {
  id: "formats-interoperability",
  label: "Formats",
  category: "security",
  order: 40,
};
const AMBIENT = {
  id: "ambient-auth",
  label: "Automatic sign-in",
  category: "security",
  order: 30,
};

const childIds = (
  tabs: ReturnType<typeof settingsPageTree>,
  id: string,
): string[] =>
  tabs.find((node) => node.id === id)?.children.map((node) => node.id) ?? [];

describe("settingsPageTree", () => {
  it("lists a directory's config.yaml first, ahead of its panels, once it is shown", () => {
    for (const tab of ["general", "security", "vaults", "capabilities"]) {
      const shown = settingsPageTree({ showHidden: true }).find(
        (node) => node.id === tab,
      );
      expect(shown?.children[0]?.id, tab).toBe(`${tab}-config`);
      expect(shown?.children.length, tab).toBeGreaterThan(1);
      // Hidden, it is not listed at all — the panels alone remain.
      const hidden = settingsPageTree().find((node) => node.id === tab);
      expect(
        hidden?.children.some((node) => node.id === `${tab}-config`),
        tab,
      ).toBe(false);
    }
  });

  it("lists each settings tab as a first-level child, never nested under another tab", () => {
    const tabs = settingsPageTree();
    // Connections is gone as a tab: every provider is configured on
    // Capabilities, under the feature (or always-on group) that uses it.
    expect(tabs.map((node) => node.label)).toEqual([
      "General",
      "Keybindings",
      "Security",
      "Vaults",
      "Capabilities",
      "Danger",
    ]);
    expect(tabs.map((node) => node.href)).toEqual([
      "/settings",
      "/settings/keybindings",
      "/settings/security",
      "/settings/vaults",
      "/settings/capabilities",
      "/settings/danger",
    ]);
    for (const tab of tabs) {
      expect(tab.branch).toBe(true);
      if (tab.id === "vaults") continue;
      for (const child of tab.children) {
        expect(child.href.startsWith("/settings/vaults")).toBe(false);
      }
    }
    const capabilities = tabs.find((node) => node.id === "capabilities");
    expect(capabilities?.children.map((node) => node.label)).toEqual(
      capabilitiesSettingsSections().map((section) => section.label),
    );
  });

  it("names the Capabilities sections: guests, then every section once", () => {
    expect(capabilitiesSettingsSections().map((s) => s.label)).toEqual([
      "Guests",
      ...FEATURES.map((feature) => feature.title),
    ]);
    expect(capabilitiesSettingsSections()[1]?.href).toBe(
      "/settings/capabilities#feature-identity",
    );
    // The operator's section is listed only where it draws, last when present.
    expect(
      capabilitiesSettingsSections(true, true)
        .map((s) => s.label)
        .at(-1),
    ).toBe("Instance policy");
  });

  it("mirrors vaults on this device under the Vaults tab only, then its panels", () => {
    const tabs = settingsPageTree({
      vaults: [
        { id: "personal", label: "personal" },
        { id: "proj-1", label: "project · 4f2a" },
      ],
      contributed: [SEALED_STORE],
    });
    const vaults = tabs.find((node) => node.id === "vaults");
    expect(vaults?.children.map((node) => node.label)).toEqual([
      "personal",
      "project · 4f2a",
      "Item types",
      "Sealed store",
    ]);
    const capabilities = tabs.find((node) => node.id === "capabilities");
    expect(capabilities?.children.map((node) => node.label)).not.toContain(
      "personal",
    );
  });

  it("keeps sources in tab order without a synthetic Settings wrapper", () => {
    expect(settingsPageSources().map((source) => source.id)).toEqual([
      "general",
      "keybindings",
      "security",
      "vaults",
      "capabilities",
      "danger",
    ]);
  });

  it("names General › Install only when the panel draws", () => {
    const general = (install: boolean) =>
      settingsPageTree({ install })
        .find((node) => node.id === "general")
        ?.children.map((node) => node.label);
    // A rail entry for a panel that returned null opened General at its
    // top with nothing to show for it.
    const always = ["Appearance", "Locking"];
    expect(general(false)).toEqual(always);
    expect(general(true)).toEqual(["Install", ...always]);
  });

  it("gives Keybindings its own tab: the keymap, the gestures and the macros", () => {
    const keybindings = settingsPageTree().find(
      (node) => node.id === "keybindings",
    );
    expect(keybindings?.children.map((node) => node.label)).toEqual([
      "Keymap",
      "Gestures",
      "Macros",
    ]);
  });

  it("gives every tab its panels, so no tab is a caret-less row among branches", () => {
    const tabs = settingsPageTree();
    // A tab with nothing under it drew without a caret, one indent left of
    // its siblings, and read as a level above them.
    expect(
      tabs.filter((tab) => tab.children.length === 0).map((tab) => tab.id),
    ).toEqual([]);
    expect(
      tabs
        .find((tab) => tab.id === "danger")
        ?.children.map((node) => node.href),
    ).toEqual([
      "/settings/danger#settings-delete-vault",
      "/settings/danger#settings-trash",
    ]);
  });

  it("lists Security's panels in the order the page draws them", () => {
    expect(childIds(settingsPageTree(), "security")).toEqual([
      "vault-key-protection",
      "unlock-methods",
      "second-step",
      "recovery",
    ]);
    // Duress (and Travel with it) and the account's factors draw only when
    // they apply; a capability's panels take the slot after the account.
    expect(
      childIds(
        settingsPageTree({
          duress: true,
          account: true,
          contributed: [FORMATS, AMBIENT],
        }),
        "security",
      ),
    ).toEqual([
      "vault-key-protection",
      "unlock-methods",
      "second-step",
      "recovery",
      "account-factors",
      "duress-profiles",
      "travel",
      "ambient-auth",
      "formats-interoperability",
    ]);
  });

  it("names a contributed panel only while its capability contributes it", () => {
    const labels = (contributed: (typeof FORMATS)[]) =>
      settingsPageTree({ contributed }).flatMap((tab) =>
        tab.children.map((node) => node.label),
      );
    expect(labels([])).not.toContain("Formats");
    expect(labels([])).not.toContain("Sealed store");
    expect(labels([FORMATS, SEALED_STORE])).toEqual(
      expect.arrayContaining(["Formats", "Sealed store"]),
    );
  });

  it("opens a contributed tab onto the panels its module says it draws", () => {
    const revoke = registerContributionForTest("settings-category", {
      id: "notifications",
      label: "Notifications",
      guideId: "settings.notifications",
      Panel: () => null,
      panels: [{ id: "notif-channels", label: "Channels" }],
      order: 300,
    });
    try {
      const tabs = settingsPageTree();
      expect(tabs.map((tab) => tab.id)).toContain("notifications");
      expect(childIds(tabs, "notifications")).toEqual(["notif-channels"]);
      // Every tab, core or contributed, is the same kind of row.
      expect(tabs.filter((tab) => tab.children.length === 0)).toEqual([]);
    } finally {
      revoke();
    }
  });
});
