import {
  createItem,
  createTypedItem,
  installItemType,
  itemTypeRegistry,
  syncInstalledTypes,
} from "@opensesame/vault-core";
import { afterEach, describe, expect, it } from "vitest";
import { pepperedAccount, plainAccount } from "../lib/account.test-support.js";
import {
  chipTypeIds,
  concealedValue,
  shareText,
} from "./vault-section-model.js";

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
    expect(chipTypeIds([createItem("account")])).toEqual(["account"]);
    expect(
      chipTypeIds([createItem("account"), createTypedItem(wifi, {})]),
    ).toEqual(["account", "wifi"]);
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
    expect(chipTypeIds([createItem("account")])).toEqual(["account", "boat"]);
  });
});

describe("shareText", () => {
  it("sends the concealed value of every item that has one", () => {
    const wifi = itemTypeRegistry().get("wifi");
    if (wifi === undefined) throw new Error("wifi is a built-in type");
    expect(shareText({ ...createItem("secret", "API"), value: "s3cr3t" })).toBe(
      "s3cr3t",
    );
    expect(shareText(plainAccount("GitHub", "hunter2"))).toBe("hunter2");
    expect(
      shareText({ ...createItem("card", "Visa"), number: "4242424242424242" }),
    ).toBe("4242424242424242");
    expect(
      shareText({
        ...createItem("certificate", "local"),
        privateKeyPem: "-----BEGIN KEY-----",
      }),
    ).toBe("-----BEGIN KEY-----");
    expect(
      shareText({
        ...createItem("passkey", "GitHub"),
        privateKeyPkcs8B64: "pkcs8",
      }),
    ).toBe("pkcs8");
    expect(
      shareText(createTypedItem(wifi, { passphrase: "network-secret" })),
    ).toBe("network-secret");
  });

  it("shares nothing of a peppered password, and falls back to notes", async () => {
    const account = await pepperedAccount("GitHub", "hunter2", "pepper");
    expect(concealedValue(account)).toBeNull();
    expect(shareText(account)).toBeNull();
    expect(shareText({ ...account, notes: "fallback" })).toBe("fallback");
  });

  it("sends a note's text, and notes when an item has no concealed value", () => {
    expect(
      shareText({ ...createItem("note", "Idea"), notes: "remember" }),
    ).toBe("remember");
    expect(
      shareText({ ...createItem("secret", "Empty"), notes: "fallback" }),
    ).toBe("fallback");
  });

  it("shares nothing for an empty item or a legacy drop record", () => {
    expect(shareText(createItem("secret", "Empty"))).toBeNull();
    expect(shareText(createItem("note", "Blank"))).toBeNull();
    expect(shareText(createItem("passkey", "No key"))).toBeNull();
    expect(shareText(createItem("drop", "Sent"))).toBeNull();
  });
});
