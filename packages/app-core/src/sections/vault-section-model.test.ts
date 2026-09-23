import {
  createItem,
  createTypedItem,
  installItemType,
  itemTypeRegistry,
  syncInstalledTypes,
} from "@opensesame/vault-core";
import { afterEach, describe, expect, it } from "vitest";
import { chipTypeIds } from "./vault-section-model.js";

const BOAT = JSON.stringify({
  apiVersion: "opensesame.dev/v1alpha1",
  kind: "VaultItemType",
  metadata: {
    id: "boat",
    version: "1.0.0",
    publisher: "https://community.test",
  },
  spec: {
    title: "Boat",
    plural: "Boats",
    extension: ".boat",
    summary: "Installed at runtime.",
    categories: ["other"],
    sections: [
      {
        id: "main",
        title: "Main",
        fields: [{ id: "label", type: "string", label: "Label" }],
      },
    ],
    native: { secret: null, trailer: [{ key: "label", field: "label" }] },
    cxf: { credential: "custom-fields" },
    subtitle: ["label"],
    search: ["label"],
  },
});

afterEach(() => syncInstalledTypes(undefined));

describe("chipTypeIds", () => {
  it("offers built-in types only once the vault holds one", () => {
    const wifi = itemTypeRegistry().get("wifi");
    if (wifi === undefined) throw new Error("wifi is a built-in type");
    expect(chipTypeIds([createItem("login")])).toEqual(["login"]);
    expect(
      chipTypeIds([createItem("login"), createTypedItem(wifi, {})]),
    ).toEqual(["login", "wifi"]);
  });

  it("offers no chip for a filter id, which would open the filter", () => {
    const wifi = itemTypeRegistry().get("wifi");
    if (wifi === undefined) throw new Error("wifi is a built-in type");
    // A type installed elsewhere under a filter's id, before that was refused.
    const stray = { ...createTypedItem(wifi, {}), typeId: "trash" };
    expect(chipTypeIds([stray])).toEqual([]);
  });

  it("offers an installed type before it holds an item", () => {
    installItemType(BOAT);
    expect(chipTypeIds([createItem("login")])).toEqual(["login", "boat"]);
  });
});
