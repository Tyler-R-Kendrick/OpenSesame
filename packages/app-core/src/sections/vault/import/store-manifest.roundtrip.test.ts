/**
 * Pages → store path manifest → Pages, for every kind the vault supports: an
 * item exported from one vault comes back into an empty one as the same kind
 * with the same values — only ids and timestamps are the new vault's own —
 * and a manifest an older Pages saved still imports without losing anything
 * the vault it came from holds.
 */
import {
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type Folder,
  type VaultItem,
  accountTotp,
  createItem,
  definitionFor,
  itemSubtitle,
  itemTypeId,
  manualPassword,
  newUri,
  readItemField,
} from "@opensesame/vault-core";
import {
  BUILTIN_TYPE_IDS,
  FIELD_TYPES,
  definitionFields,
} from "@opensesame/vault-item-types";
import { describe, expect, it } from "vitest";
import { producedPassword } from "../../../lib/account.test-support.js";
import { planManifestMerge } from "../../../lib/vault/store-sync.js";
import { type FixtureVault, everyKindVault } from "./store-manifest.fixture.js";
import {
  planStoreManifest,
  readStoreManifest,
  storeManifestFile,
} from "./store-manifest.js";

/** The keys a vault assigns for itself, which no import can carry over. */
const OWN = new Set(["id", "createdAt", "updatedAt", "deletedAt", "folderId"]);

/** What an import never carries into a vault, whatever the file says. */
const NOT_CONFERRED = new Set([
  "unlocksVault",
  "ceiling",
  "grantees",
  "connectionRef",
]);

/** Drop the vault-assigned `id` of every nested row (a URI, a field, a grant). */
function withoutRowIds(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(withoutRowIds);
  if (!isJsonObject(value)) return value;
  const out: MutableJsonObject = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key !== "id" && inner !== undefined) out[key] = withoutRowIds(inner);
  }
  return out;
}

/** An item as a comparison sees it: its folder by name, no vault-owned keys. */
function comparable(item: VaultItem, folders: readonly Folder[]): JsonObject {
  const record: JsonObject = overlapCast(item);
  const out: MutableJsonObject = {
    folder: folders.find((folder) => folder.id === item.folderId)?.name ?? null,
  };
  for (const [key, value] of Object.entries(record)) {
    // `unlocksVault` is a claim about the vault that enrolled the passkey,
    // and a secret's authority is never conferred by a file (see below).
    if (OWN.has(key) || NOT_CONFERRED.has(key) || value === undefined) continue;
    out[key] = withoutRowIds(value);
  }
  return out;
}

function exportAndImport(items: VaultItem[], folders: Folder[]) {
  const file = storeManifestFile(items, folders);
  const entries = readStoreManifest(JSON.parse(file.text));
  if (entries === null) throw new Error("the saved file is not a manifest");
  const plan = planStoreManifest(entries, [], []);
  return { file, entries, plan };
}

describe("store path manifest round trip, every kind", () => {
  const vault = everyKindVault();
  const { entries, plan } = exportAndImport(vault.items, vault.folders);
  const byName = new Map(plan.adds.map((item) => [item.name, item]));

  it("holds one item of every built-in item type", () => {
    const ids = new Set(vault.items.map(itemTypeId));
    expect([...ids].sort()).toEqual([...BUILTIN_TYPE_IDS].sort());
  });

  it("imports into an empty vault as new items only", () => {
    expect(plan.adds).toHaveLength(vault.items.length);
    expect(plan).toMatchObject({ updates: [], unchanged: 0, kept: 0 });
  });

  it.each(vault.items.map((item) => [itemTypeId(item), item] as const))(
    "%s comes back as the same kind with the same values",
    (_id, item) => {
      const back = byName.get(item.name);
      expect(back).toBeDefined();
      if (back === undefined) return;
      expect(comparable(back, plan.newFolders)).toEqual(
        comparable(item, vault.folders),
      );
    },
  );

  it("confers no authority: a new secret arrives with no ceiling, grantees or ConnectionRef", () => {
    const secrets = plan.adds.filter((item) => item.kind === "secret");
    expect(secrets.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect(secret).toMatchObject({
        ceiling: [],
        grantees: [],
        connectionRef: "",
      });
    }
  });

  it("never widens an existing secret's authority, whatever the file says", () => {
    const secret = vault.items.find((item) => item.kind === "secret");
    expect(secret?.kind).toBe("secret");
    if (secret?.kind !== "secret") return;
    const narrow: VaultItem = {
      ...secret,
      ceiling: [],
      grantees: [],
      connectionRef: "",
    };
    const items = vault.items.map((item) =>
      item.id === secret.id ? narrow : item,
    );
    // The file is the one this vault saved, with the secret's value rotated
    // so it is a real update, and the wide authority it held before.
    const widened = entries.map((entry) =>
      entry.path.endsWith(secret.name)
        ? { ...entry, secret: "rotated" }
        : entry,
    );
    const again = planStoreManifest(widened, items, vault.folders);
    const update = again.updates.find((item) => item.id === secret.id);
    expect(update).toMatchObject({
      value: "rotated",
      ceiling: [],
      grantees: [],
      connectionRef: "",
    });
  });

  it("keeps line one a single line, so pass seal stores each entry exactly", () => {
    for (const entry of entries) expect(entry.secret).not.toMatch(/[\r\n]/u);
  });

  it("puts no concealed value in a path or a list subtitle", () => {
    for (const item of vault.items) {
      const concealed = concealedValues(item);
      const path = entries.find((entry) =>
        entry.path.endsWith(item.name),
      )?.path;
      const back = byName.get(item.name);
      for (const value of concealed) {
        expect(path).not.toContain(value);
        if (back) expect(itemSubtitle(back)).not.toContain(value);
      }
    }
  });

  it("a second import of the same file changes nothing", () => {
    const again = planStoreManifest(entries, plan.adds, plan.newFolders);
    expect(again).toMatchObject({
      adds: [],
      updates: [],
      newFolders: [],
      unchanged: entries.length,
      kept: 0,
    });
  });
});

/**
 * Exactly what Pages saved before kinds round-tripped (trailer format 1, no
 * `v`): an account, a secret, a note and a typed item whole; a card's holder and
 * a certificate's name and PEM folded into notes; a drop with nothing.
 */
const KEY_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIOldFormatFixture\n-----END PRIVATE KEY-----";
const CERT_PEM =
  "-----BEGIN CERTIFICATE-----\nMIIBoldFormat\n-----END CERTIFICATE-----";
const OLD_MANIFEST = [
  {
    path: "Work/GitHub",
    secret: "hunter2",
    trailer:
      '{"kind":"login","notes":"n","username":"ada","totp":"JBSWY3DPEHPK3PXP","uris":["https://a.example"],"uriMatches":["host"]}\n',
  },
  {
    path: "Travel card",
    secret: "4111111111111111",
    trailer: '{"kind":"card","notes":"A. Rowan\\nexpires soon"}\n',
  },
  {
    path: "Key",
    secret: "Y3JlZA==",
    trailer: '{"kind":"passkey","notes":"yubikey"}\n',
  },
  {
    path: "dev.local",
    secret: KEY_PEM,
    trailer: `${JSON.stringify({ kind: "certificate", notes: `dev.local\n${CERT_PEM}` })}\n`,
  },
  {
    path: "Work/Deploy hook",
    secret: "whsec_old",
    trailer: '{"kind":"secret","connectionRef":"conn_1"}\n',
  },
  { path: "Recovery", secret: "seed words", trailer: '{"kind":"note"}\n' },
  { path: "Shared wifi", secret: "", trailer: '{"kind":"drop"}\n' },
];

/** The vault the old manifest above was saved from, with what it left out. */
function oldVault(): FixtureVault {
  const work: Folder = { id: "fld_work", name: "Work", createdAt: "x" };
  const github = createItem("account", "GitHub");
  Object.assign(github, {
    folderId: work.id,
    username: "ada",
    methods: [
      manualPassword(`${github.id}:password`, "hunter2", github.createdAt),
      {
        id: `${github.id}:authenticator`,
        type: "authenticator",
        secret: "JBSWY3DPEHPK3PXP",
      },
    ],
    uris: [newUri("https://a.example", "host")],
    notes: "n",
    fields: [{ id: "f", name: "PIN", value: "9999", hidden: true }],
  });
  const card = createItem("card", "Travel card");
  Object.assign(card, {
    number: "4111111111111111",
    cardholder: "A. Rowan",
    code: "123",
    notes: "expires soon",
  });
  const key = createItem("passkey", "Key");
  Object.assign(key, {
    credentialIdB64: "Y3JlZA==",
    rpId: "example.com",
    notes: "yubikey",
  });
  const cert = createItem("certificate", "dev.local");
  Object.assign(cert, { privateKeyPem: KEY_PEM, certificatePem: CERT_PEM });
  const hook = createItem("secret", "Deploy hook");
  Object.assign(hook, {
    folderId: work.id,
    value: "whsec_old",
    connectionRef: "conn_1",
    grantees: ["agent:ci"],
  });
  const recovery = createItem("note", "Recovery");
  recovery.notes = "seed words";
  const drop = createItem("drop", "Shared wifi");
  Object.assign(drop, { claimId: "claim_1", bearerToken: "b" });
  return {
    items: [github, card, key, cert, hook, recovery, drop],
    folders: [work],
  };
}

describe("a manifest an older Pages saved (trailer format 1)", () => {
  const entries = readStoreManifest(OLD_MANIFEST) ?? [];

  it("imports every entry as its own kind, line one where it was", () => {
    const plan = planStoreManifest(entries, [], []);
    const kinds = Object.fromEntries(
      plan.adds.map((item) => [item.name, item.kind]),
    );
    expect(kinds).toEqual({
      GitHub: "account",
      "Travel card": "card",
      Key: "passkey",
      "dev.local": "certificate",
      "Deploy hook": "secret",
      Recovery: "note",
      "Shared wifi": "drop",
    });
    const by = new Map(plan.adds.map((item) => [item.name, item]));
    const github = by.get("GitHub");
    if (github?.kind !== "account") throw new Error("expected an account");
    expect(github).toMatchObject({
      username: "ada",
      notes: "n",
      uris: [{ uri: "https://a.example", match: "host" }],
    });
    expect(producedPassword(github)).toBe("hunter2");
    expect(accountTotp(github)).toBe("JBSWY3DPEHPK3PXP");
    // What format 1 folded into notes stays readable there.
    expect(by.get("Travel card")).toMatchObject({
      number: "4111111111111111",
      notes: "A. Rowan\nexpires soon",
    });
    expect(by.get("Key")).toMatchObject({
      credentialIdB64: "Y3JlZA==",
      notes: "yubikey",
    });
    expect(by.get("dev.local")).toMatchObject({ privateKeyPem: KEY_PEM });
    // The value comes back; the ConnectionRef the file named does not.
    expect(by.get("Deploy hook")).toMatchObject({
      value: "whsec_old",
      connectionRef: "",
    });
    expect(by.get("Recovery")).toMatchObject({ notes: "seed words" });
  });

  it("merges back into the vault it came from without changing or losing anything", () => {
    const { items, folders } = oldVault();
    const plan = planStoreManifest(entries, items, folders);
    expect(plan).toMatchObject({
      adds: [],
      updates: [],
      newFolders: [],
      unchanged: entries.length,
      kept: 0,
    });
  });

  it("is unchanged to the merge planner itself, not only to the Import sheet", () => {
    const { items, folders } = oldVault();
    expect(planManifestMerge(entries, items, folders)).toMatchObject({
      adds: [],
      updates: [],
      unchanged: entries.length,
    });
  });

  it("grafts only what it carried onto the item at its path", () => {
    const { items, folders } = oldVault();
    const rotated = entries.map((entry) =>
      entry.path === "Work/GitHub" ? { ...entry, secret: "rotated" } : entry,
    );
    const plan = planStoreManifest(rotated, items, folders);
    expect(plan.updates).toHaveLength(1);
    const updated = plan.updates[0];
    if (updated?.kind !== "account") throw new Error("expected an account");
    expect(updated.id).toBe(items[0]?.id);
    expect(producedPassword(updated)).toBe("rotated");
    expect(updated.fields).toMatchObject([
      { name: "PIN", value: "9999", hidden: true },
    ]);
  });
});

/** Every concealed value on an item — its definition's and its custom fields'. */
function concealedValues(item: VaultItem): string[] {
  const hidden = item.fields.filter((f) => f.hidden).map((f) => f.value);
  const definition = definitionFor(item);
  for (const field of definition ? definitionFields(definition) : []) {
    const spec = FIELD_TYPES[field.type];
    const value = readItemField(item, field);
    if (spec.concealed && isString(value) && value !== "") hidden.push(value);
    if (!isJsonObject(value)) continue;
    for (const part of spec.parts) {
      const inner = value[part.id];
      if (part.concealed && isString(inner) && inner !== "") hidden.push(inner);
    }
  }
  return hidden;
}
