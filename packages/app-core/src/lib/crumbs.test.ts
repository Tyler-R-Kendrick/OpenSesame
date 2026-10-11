import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerLegacyShellData } from "./contributions.test-support.js";
import {
  accessImportPath,
  accessIsImportCeremony,
  accessIsNewCeremony,
  accessNewPath,
  crumbsFor,
  settingsCategoryFromHash,
  settingsCategoryFromLocation,
  settingsFileRoute,
  settingsPath,
} from "./crumbs.js";

// Connections, Access, Identity and Wallet are contributed sections; a crumb
// path under one of them exists only while its capability is in the plan.
let revoke = () => {};
beforeAll(() => {
  revoke = registerLegacyShellData();
});
afterAll(() => revoke());

describe("settings rest paths", () => {
  it("reads a category from the path, then the hash", () => {
    // Connections and Backups became the providers of Settings › Capabilities
    // (ADR 0135), which split into Features and Integrations (ADR 0188).
    expect(settingsCategoryFromLocation("/settings/connections", "")).toBe(
      "integrations",
    );
    expect(settingsCategoryFromLocation("/settings/connectivity", "")).toBe(
      "integrations",
    );
    expect(settingsCategoryFromLocation("/settings/backups", "")).toBe(
      "integrations",
    );
    expect(settingsCategoryFromLocation("/settings/capabilities", "")).toBe(
      "features",
    );
    expect(settingsCategoryFromLocation("/settings", "#security")).toBe(
      "security",
    );
    expect(settingsCategoryFromHash("#import")).toBeNull();
    expect(settingsCategoryFromLocation("/settings", "")).toBe("general");
  });

  it("maps legacy hashes onto rest paths", () => {
    expect(settingsCategoryFromHash("#github-backup")).toBeNull();
    expect(settingsCategoryFromHash("#taskbus")).toBe("integrations");
    expect(settingsCategoryFromHash("#connectivity")).toBe("integrations");
    expect(settingsCategoryFromHash("#connections")).toBe("integrations");
    expect(settingsCategoryFromHash("#capabilities")).toBe("features");
    expect(settingsPath("features")).toBe("/settings/features");
    expect(settingsPath("integrations")).toBe("/settings/integrations");
    expect(settingsPath("general")).toBe("/settings");
  });
});

describe("crumbsFor", () => {
  it("is a single current crumb on a section home", () => {
    expect(crumbsFor("/vault")).toEqual([{ label: "Vault" }]);
    expect(crumbsFor("/connections")).toEqual([{ label: "Connections" }]);
    expect(crumbsFor("/settings")).toEqual([{ label: "Settings" }]);
    expect(crumbsFor("/identity")).toEqual([{ label: "Identity" }]);
    expect(crumbsFor("/access")).toEqual([{ label: "Access" }]);
    expect(crumbsFor("/access/new")).toEqual([
      { label: "Access", to: "/access" },
      { label: "new" },
    ]);
    expect(crumbsFor("/access/import")).toEqual([
      { label: "Access", to: "/access" },
      { label: "import" },
    ]);
    expect(crumbsFor("/access/connectors/new")).toEqual([
      { label: "Access", to: "/access" },
      { label: "connectors", to: "/access/connectors" },
      { label: "new" },
    ]);
    expect(accessNewPath("grants")).toBe("/access/new");
    expect(accessNewPath("connectors")).toBe("/access/connectors/new");
    expect(accessImportPath()).toBe("/access/import");
    expect(accessIsNewCeremony("/access/new")).toBe(true);
    expect(accessIsNewCeremony("/access/connectors/new")).toBe(true);
    expect(accessIsNewCeremony("/access/connectors")).toBe(false);
    expect(accessIsImportCeremony("/access/import")).toBe(true);
  });

  it("links ancestors on vault rest paths", () => {
    expect(crumbsFor("/vault/health")).toEqual([
      { label: "Vault", to: "/vault" },
      { label: "Password health" },
    ]);
    for (const path of ["/vault/new/account", "/vault/new/login"]) {
      expect(crumbsFor(path)).toEqual([
        { label: "Vault", to: "/vault" },
        { label: "New account" },
      ]);
    }
    expect(
      crumbsFor("/vault/itm_1", "", {
        itemName: "Work SSH",
        folderName: "Work",
        folderId: "fld_1",
      }),
    ).toEqual([
      { label: "Vault", to: "/vault" },
      { label: "Work", to: "/vault?folder=fld_1" },
      { label: "Work SSH" },
    ]);
    expect(
      crumbsFor("/vault/itm_1/edit", "", { itemName: "Work SSH" }),
    ).toEqual([
      { label: "Vault", to: "/vault" },
      { label: "Work SSH" },
      { label: "Edit" },
    ]);
  });

  it("links vault filters and folders", () => {
    expect(crumbsFor("/vault", "?f=account")).toEqual([
      { label: "Vault", to: "/vault" },
      { label: "Accounts" },
    ]);
    // Links handed out before accounts still land on them.
    for (const legacy of ["?f=login", "?f=logins"]) {
      expect(crumbsFor("/vault", legacy)).toEqual([
        { label: "Vault", to: "/vault" },
        { label: "Accounts" },
      ]);
    }
    expect(
      crumbsFor("/vault", "?folder=fld_1", {
        folderName: "Work",
        folderId: "fld_1",
      }),
    ).toEqual([{ label: "Vault", to: "/vault" }, { label: "Work" }]);
  });

  it("links connection rest paths", () => {
    expect(crumbsFor("/connections/github")).toEqual([
      { label: "Connections", to: "/connections" },
      { label: "github" },
    ]);
    expect(
      crumbsFor("/connections/github/conn_1", "", {
        providerName: "GitHub",
        connectionName: "prod",
      }),
    ).toEqual([
      { label: "Connections", to: "/connections" },
      { label: "GitHub", to: "/connections/github" },
      { label: "prod" },
    ]);
  });

  it("links settings rest paths", () => {
    expect(crumbsFor("/settings/connections")).toEqual([
      { label: "Settings", to: "/settings" },
      { label: "Integrations" },
    ]);
    // A connector page's parent is the page that configures it.
    expect(crumbsFor("/settings/connections/github")).toEqual([
      { label: "Settings", to: "/settings" },
      { label: "Integrations", to: "/settings/integrations" },
      { label: "github" },
    ]);
    expect(crumbsFor("/settings/connections/github/conn_1")).toEqual([
      { label: "Settings", to: "/settings" },
      { label: "Integrations", to: "/settings/integrations" },
      { label: "github", to: "/settings/connections/github" },
      { label: "conn_1" },
    ]);
  });
});

describe("a settings directory's config.yaml", () => {
  it("is a file inside its directory, whose category it keeps", () => {
    expect(crumbsFor("/settings", "?file=config.yaml")).toEqual([
      { label: "Settings", to: "/settings" },
      { label: "General", to: "/settings" },
      { label: "config.yaml" },
    ]);
    expect(crumbsFor("/settings/features", "?file=config.yaml")).toEqual([
      { label: "Settings", to: "/settings" },
      { label: "Features", to: "/settings/features" },
      { label: "config.yaml" },
    ]);
    // An older Capabilities link reads as the page its switches moved to, and
    // an older Connections link as the one its providers did.
    expect(crumbsFor("/settings/capabilities", "?file=config.yaml")).toEqual([
      { label: "Settings", to: "/settings" },
      { label: "Features", to: "/settings/features" },
      { label: "config.yaml" },
    ]);
    expect(crumbsFor("/settings/connections", "?file=config.yaml")).toEqual([
      { label: "Settings", to: "/settings" },
      { label: "Integrations", to: "/settings/integrations" },
      { label: "config.yaml" },
    ]);
  });
});

describe("any file a settings directory keeps", () => {
  it("is addressed on its directory's route, and named by its file", () => {
    const path = "settings/item-types/builtin/wifi.json";
    expect(settingsFileRoute("vaults", path)).toBe(
      "/settings/vaults?file=settings%2Fitem-types%2Fbuiltin%2Fwifi.json",
    );
    expect(
      crumbsFor("/settings/vaults", `?file=${encodeURIComponent(path)}`)[2],
    ).toEqual({ label: "wifi.json" });
  });
});
