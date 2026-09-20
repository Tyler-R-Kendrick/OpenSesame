import { describe, expect, it } from "vitest";
import {
  accessImportPath,
  accessIsImportCeremony,
  accessIsNewCeremony,
  accessNewPath,
  crumbsFor,
  settingsCategoryFromHash,
  settingsCategoryFromLocation,
  settingsPath,
} from "./crumbs.js";

describe("settings rest paths", () => {
  it("reads a category from the path, then the hash", () => {
    expect(settingsCategoryFromLocation("/settings/connections", "")).toBe(
      "connections",
    );
    expect(settingsCategoryFromLocation("/settings/connectivity", "")).toBe(
      "connections",
    );
    expect(settingsCategoryFromLocation("/settings", "#security")).toBe(
      "security",
    );
    expect(settingsCategoryFromHash("#import")).toBeNull();
    expect(settingsCategoryFromLocation("/settings", "")).toBe("general");
  });

  it("maps legacy hashes onto rest paths", () => {
    expect(settingsCategoryFromHash("#github-backup")).toBeNull();
    expect(settingsCategoryFromHash("#taskbus")).toBe("connections");
    expect(settingsCategoryFromHash("#connectivity")).toBe("connections");
    expect(settingsPath("connections")).toBe("/settings/connections");
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
    expect(crumbsFor("/vault/new/login")).toEqual([
      { label: "Vault", to: "/vault" },
      { label: "New login" },
    ]);
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
    expect(crumbsFor("/vault", "?f=login")).toEqual([
      { label: "Vault", to: "/vault" },
      { label: "Logins" },
    ]);
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
      { label: "Connections" },
    ]);
    expect(crumbsFor("/settings/connections/github")).toEqual([
      { label: "Settings", to: "/settings" },
      { label: "Connections", to: "/settings/connections" },
      { label: "github" },
    ]);
    expect(crumbsFor("/settings/connections/github/conn_1")).toEqual([
      { label: "Settings", to: "/settings" },
      { label: "Connections", to: "/settings/connections" },
      { label: "github", to: "/settings/connections/github" },
      { label: "conn_1" },
    ]);
  });
});
