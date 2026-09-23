import { toNativeEntry } from "@opensesame/vault-item-types";
import { beforeEach, describe, expect, it } from "vitest";
import { buildCxfExport } from "./export/cxf.js";
import {
  definitionFor,
  installItemType,
  installedDefinitions,
  itemTypeId,
  itemTypeRegistry,
  itemValues,
  newValues,
  syncInstalledTypes,
  typeExtension,
  typeLabel,
  typedSearchText,
  typedSubtitle,
  uninstallItemType,
  unknownTypeSubtitle,
} from "./item-types.js";
import {
  createItem,
  createTypedItem,
  itemSubtitle,
  searchMatches,
} from "./model.js";
import { entryToVaultItem, vaultItemToEntry } from "./store-sync.js";

const RESIDENT_ID = JSON.stringify({
  apiVersion: "opensesame.dev/v1alpha1",
  kind: "VaultItemType",
  metadata: {
    id: "resident-id",
    version: "1.0.0",
    publisher: "https://community.test",
  },
  spec: {
    title: "Resident ID",
    plural: "Resident IDs",
    extension: ".rid",
    summary: "A national residence permit.",
    categories: ["identity"],
    sections: [
      {
        id: "card",
        title: "Card",
        fields: [
          { id: "country", type: "country", label: "Country", required: true },
          { id: "permitNumber", type: "concealed", label: "Permit number" },
          { id: "expiresAt", type: "date", label: "Expires" },
        ],
      },
    ],
    native: {
      secret: "permitNumber",
      trailer: [
        { key: "country", field: "country" },
        { key: "expires_at", field: "expiresAt" },
      ],
    },
    cxf: { credential: "identity-document" },
    subtitle: ["country", "expiresAt"],
    search: ["country"],
  },
});

function residentItem() {
  const definition = itemTypeRegistry().get("resident-id");
  if (definition === undefined) throw new Error("resident-id is not installed");
  return createTypedItem(
    definition,
    {
      ...newValues(definition),
      country: "NL",
      permitNumber: "Z1234567",
      expiresAt: "2030-01-01",
    },
    "Residence permit",
  );
}

describe("the device registry", () => {
  beforeEach(() => {
    syncInstalledTypes({});
  });

  it("ships every built-in type as a definition, logins included", () => {
    const ids = itemTypeRegistry()
      .list()
      .map(({ definition }) => definition.metadata.id);
    for (const legacy of ["login", "passkey", "card", "secret", "note"]) {
      expect(ids).toContain(legacy);
    }
    expect(typeLabel("login")).toBe("Login");
    expect(typeExtension("card")).toBe(".card");
  });

  it("installs a community type at runtime and reports it as installed", () => {
    expect(itemTypeRegistry().has("resident-id")).toBe(false);
    const result = installItemType(RESIDENT_ID);
    expect(result.ok).toBe(true);
    expect(itemTypeRegistry().has("resident-id")).toBe(true);
    expect(typeLabel("resident-id")).toBe("Resident ID");
    expect(typeExtension("resident-id")).toBe(".rid");
    expect(Object.keys(installedDefinitions())).toEqual(["resident-id"]);
  });

  it("reports a refusal in words the definition author can act on", () => {
    const result = installItemType(
      RESIDENT_ID.replace(
        '"subtitle":["country","expiresAt"]',
        '"subtitle":["permitNumber"]',
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("concealed");
  });

  it("uninstalls a type without dropping it from the vault's items", () => {
    installItemType(RESIDENT_ID);
    const item = residentItem();
    expect(uninstallItemType("resident-id")).toBe(true);
    expect(itemTypeRegistry().has("resident-id")).toBe(false);
    expect(installedDefinitions()).toEqual({});
    // The item is untouched: every value it held is still on it.
    expect(item.values.permitNumber).toBe("Z1234567");
    expect(definitionFor(item)).toBeUndefined();
  });

  it("rebuilds itself from what the sealed body carries", () => {
    syncInstalledTypes({ "resident-id": RESIDENT_ID });
    expect(itemTypeRegistry().has("resident-id")).toBe(true);
    syncInstalledTypes({});
    expect(itemTypeRegistry().has("resident-id")).toBe(false);
  });

  it("skips a definition it cannot parse rather than failing the unlock", () => {
    syncInstalledTypes({ broken: "{ not json", "resident-id": RESIDENT_ID });
    expect(itemTypeRegistry().has("broken")).toBe(false);
    expect(itemTypeRegistry().has("resident-id")).toBe(true);
  });
});

describe("previews", () => {
  beforeEach(() => {
    syncInstalledTypes({ "resident-id": RESIDENT_ID });
  });

  it("builds a subtitle from the declared fields and never a concealed one", () => {
    const item = residentItem();
    expect(typedSubtitle(item)).toBe("NL · 2030-01-01");
    expect(typedSubtitle(item)).not.toContain("Z1234567");
    expect(itemSubtitle(item)).toBe("NL · 2030-01-01");
  });

  it("searches the declared fields and never a concealed one", () => {
    const item = residentItem();
    expect(typedSearchText(item)).toEqual(["NL"]);
    expect(searchMatches(item, "NL")).toBe(true);
    expect(searchMatches(item, "Z1234567")).toBe(false);
  });

  it("says a type is missing rather than showing a value it cannot classify", () => {
    const item = residentItem();
    syncInstalledTypes({});
    expect(unknownTypeSubtitle(item)).toContain("type not installed");
    expect(itemSubtitle(item)).not.toContain("Z1234567");
  });
});

describe("the legacy seam", () => {
  beforeEach(() => {
    syncInstalledTypes({});
  });

  it("reads a built-in item's named properties through its definition", () => {
    const login = createItem("login", "Example");
    login.username = "ada";
    login.password = "correct horse";
    login.uris = [{ id: "u1", uri: "https://example.test", match: "domain" }];
    const definition = definitionFor(login);
    expect(definition).toBeDefined();
    if (definition === undefined) return;
    const values = itemValues(login, definition);
    expect(values.username).toBe("ada");
    expect(values.password).toBe("correct horse");
    expect(values.uris).toEqual(["https://example.test"]);
  });

  it("projects a built-in login onto a pass entry through its definition", () => {
    const login = createItem("login", "Example");
    login.username = "ada";
    login.password = "correct horse";
    const definition = definitionFor(login);
    if (definition === undefined) throw new Error("login is not registered");
    const entry = toNativeEntry(definition, itemValues(login, definition));
    expect(entry.secret).toBe("correct horse");
    expect(entry.trailer).toContain("login: ada");
  });

  it("flattens a passkey's boolean into the text its definition declared", () => {
    const passkey = createItem("passkey", "Example");
    passkey.rpId = "example.test";
    passkey.unlocksVault = true;
    const definition = definitionFor(passkey);
    if (definition === undefined) throw new Error("passkey is not registered");
    expect(itemValues(passkey, definition).unlocksVault).toBe("true");
  });

  it("gives every item a type id, whichever shape it is stored in", () => {
    expect(itemTypeId(createItem("card", "Card"))).toBe("card");
    syncInstalledTypes({ "resident-id": RESIDENT_ID });
    expect(itemTypeId(residentItem())).toBe("resident-id");
  });
});

describe("a plugin-defined item survives every path out of the vault", () => {
  beforeEach(() => {
    syncInstalledTypes({ "resident-id": RESIDENT_ID });
  });

  it("round-trips through the sealed-store sync seam with nothing lost", () => {
    const item = residentItem();
    const entry = vaultItemToEntry(item, []);
    // Line one is the field the definition nominated, so the entry reads
    // sensibly to anything that opens it.
    expect(entry.secret).toBe("Z1234567");
    const back = entryToVaultItem(entry, null);
    expect(back.kind).toBe("typed");
    if (back.kind !== "typed") return;
    expect(back.typeId).toBe("resident-id");
    expect(back.values.country).toBe("NL");
    expect(back.values.permitNumber).toBe("Z1234567");
    expect(back.values.expiresAt).toBe("2030-01-01");
  });

  it("round-trips even on a device that has never seen the definition", () => {
    const item = residentItem();
    const entry = vaultItemToEntry(item, []);
    syncInstalledTypes({});
    const back = entryToVaultItem(entry, null);
    expect(back.kind).toBe("typed");
    if (back.kind !== "typed") return;
    expect(back.typeId).toBe("resident-id");
    expect(back.values.permitNumber).toBe("Z1234567");
  });

  it("exports every declared value to CXF, concealment intact", () => {
    const item = residentItem();
    const result = buildCxfExport(
      { v: 1, items: [item], folders: [] },
      { humanConfirmed: true },
    );
    const credentials =
      result.document.accounts[0]?.items[0]?.credentials ?? [];
    const custom = credentials.find(
      (credential) => credential.type === "custom-fields",
    );
    expect(custom).toBeDefined();
    if (custom === undefined || custom.type !== "custom-fields") return;
    const byLabel = new Map(custom.fields.map((f) => [f.label, f]));
    expect(byLabel.get("Country")?.value).toBe("NL");
    expect(byLabel.get("Country")?.fieldType).toBe("string");
    expect(byLabel.get("Permit number")?.value).toBe("Z1234567");
    // The field type carries the intent an importer needs to keep hiding it.
    expect(byLabel.get("Permit number")?.fieldType).toBe("concealed-string");
    expect(result.skipped).toEqual([]);
  });

  it("exports its values even when the definition is not installed", () => {
    const item = residentItem();
    syncInstalledTypes({});
    const result = buildCxfExport(
      { v: 1, items: [item], folders: [] },
      { humanConfirmed: true },
    );
    const credentials =
      result.document.accounts[0]?.items[0]?.credentials ?? [];
    const custom = credentials.find(
      (credential) => credential.type === "custom-fields",
    );
    expect(custom).toBeDefined();
    if (custom === undefined || custom.type !== "custom-fields") return;
    // Nothing is dropped, and nothing is claimed to be safe to show.
    expect(custom.fields.map((f) => f.value)).toContain("Z1234567");
    for (const row of custom.fields) {
      expect(row.fieldType).toBe("concealed-string");
    }
  });
});
