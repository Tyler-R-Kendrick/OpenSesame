import { describe, expect, it } from "vitest";
import {
  crumbsFor,
  settingsCategoryFromHash,
  settingsCategoryFromLocation,
  settingsPath,
} from "./crumbs.js";

describe("settings rest paths", () => {
  it("reads a category from the path, then the hash", () => {
    expect(settingsCategoryFromLocation("/settings/connectivity", "")).toBe(
      "connectivity",
    );
    expect(settingsCategoryFromLocation("/settings", "#security")).toBe(
      "security",
    );
    expect(settingsCategoryFromLocation("/settings", "#import")).toBe("data");
    expect(settingsCategoryFromLocation("/settings", "")).toBe("general");
  });

  it("maps legacy hashes onto rest paths", () => {
    expect(settingsCategoryFromHash("#github-backup")).toBe("data");
    expect(settingsCategoryFromHash("#taskbus")).toBe("connectivity");
    expect(settingsPath("connectivity")).toBe("/settings/connectivity");
    expect(settingsPath("general")).toBe("/settings");
    expect(settingsPath("data", "#import")).toBe("/settings/data#import");
  });
});

describe("crumbsFor", () => {
  it("is a single current crumb on a section home", () => {
    expect(crumbsFor("/vault")).toEqual([{ label: "Vault" }]);
    expect(crumbsFor("/connections")).toEqual([{ label: "Connections" }]);
    expect(crumbsFor("/settings")).toEqual([{ label: "Settings" }]);
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
    expect(crumbsFor("/settings/connectivity")).toEqual([
      { label: "Settings", to: "/settings" },
      { label: "Connectivity" },
    ]);
  });
});
