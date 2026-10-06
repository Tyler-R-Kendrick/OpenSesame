/**
 * Legacy `login` items are accounts everywhere a body is read (ADR 0172 §1):
 * a vault file, a merge, a re-save. Nothing writes `login` again, and a
 * peppered or Sphinx method crosses all of it untouched.
 */
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  type AccountItem,
  type LegacyLoginItem,
  authenticatorMethod,
  methodsOfType,
  passwordMethod,
} from "./account.js";
import { resolveAccounts } from "./credential.js";
import { createVault, openJson, sealJson, vaultSealBinding } from "./crypto.js";
import { mergeVaultBodies, sameVaultContent } from "./merge.js";
import { type VaultBody, type VaultItem, emptyBody } from "./model.js";
import {
  buildOfflineBackupEnvelope,
  serializeOfflineBackupEnvelope,
} from "./offline-backup-format.js";
import {
  openWithPepper,
  pepperBinding,
  sealWithPepper,
} from "./pepper-seal.js";
import { hasLegacyItems, normalizeVaultBody } from "./seal-open.js";
import { openVaultFile, readVaultFile } from "./vault-file.js";

const PASSWORD = "correct horse battery staple";
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const T2 = "2026-01-03T00:00:00.000Z";

function legacy(id: string, updatedAt = T0): LegacyLoginItem {
  return {
    id,
    kind: "login",
    name: `Login ${id}`,
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: T0,
    updatedAt,
    deletedAt: null,
    username: "ada",
    password: "hunter2",
    totp: "JBSWY3DPEHPK3PXP",
    uris: [{ id: `${id}-u`, uri: "https://example.com", match: "domain" }],
    passwordChangedAt: T0,
  };
}

/** A body as a pre-ADR-0172 writer left it: `login` items inside. */
function legacyBody(...logins: LegacyLoginItem[]): VaultBody {
  return Object.assign(emptyBody(), { items: logins, rev: 1 });
}

/** The account as a surface reads it: its methods filled from the credentials bound to it. */
function accountOf(body: VaultBody, id: string): AccountItem {
  const item = resolveAccounts(body.items).find(
    (candidate) => candidate.id === id,
  );
  if (item?.kind !== "account") throw new Error(`no account ${id}`);
  return item;
}

async function backupOf(body: VaultBody): Promise<string> {
  const { header, vaultKey } = await createVault(PASSWORD);
  const sealed = await sealJson(
    vaultKey,
    body,
    vaultSealBinding("personal", "body"),
  );
  return serializeOfflineBackupEnvelope(
    buildOfflineBackupEnvelope({
      header: { ...header, bodyRev: 1 },
      body: sealed,
    }),
  );
}

describe("a legacy login body opens as accounts", () => {
  it("lists every login as an account and holds none in memory", async () => {
    const file = await backupOf(legacyBody(legacy("a"), legacy("b")));
    const opened = await openVaultFile(file, PASSWORD);
    expect(opened.items.map((item) => item.kind)).toEqual([
      "account",
      "account",
    ]);
    expect(JSON.stringify(opened)).not.toContain("login");
  });

  it("re-saves with no login and keeps the password and the seed", async () => {
    const normalized = normalizeVaultBody(legacyBody(legacy("a")));
    expect(hasLegacyItems(normalized)).toBe(false);
    const account = accountOf(normalized, "a");
    expect(passwordMethod(account)?.secret).toBe("hunter2");
    expect(authenticatorMethod(account)?.secret).toBe("JBSWY3DPEHPK3PXP");

    // Seal it, open it, seal it again: the bytes written never say `login`.
    const { vaultKey } = await createVault(PASSWORD);
    const binding = vaultSealBinding("personal", "body");
    const reopened = await openJson<VaultBody>(
      vaultKey,
      await sealJson(vaultKey, normalized, binding),
      binding,
    );
    expect(JSON.stringify(reopened)).not.toContain('"kind":"login"');
    expect(JSON.stringify(reopened)).toBe(JSON.stringify(normalized));
  });

  it("is idempotent and leaves a body with no login as it is", () => {
    const once = normalizeVaultBody(legacyBody(legacy("a")));
    expect(normalizeVaultBody(once)).toBe(once);
    expect(normalizeVaultBody(normalizeVaultBody(once))).toEqual(once);
    const plain = emptyBody();
    expect(normalizeVaultBody(plain)).toBe(plain);
  });

  it("reads a login an old writer left a field out of", () => {
    const { totp: _t, passwordChangedAt: _p, ...rest } = legacy("a");
    const body = legacyBody(overlapCast(rest));
    const account = accountOf(normalizeVaultBody(body), "a");
    expect(passwordMethod(account)?.changedAt).toBe(T0);
    expect(methodsOfType(account, "authenticator")).toHaveLength(0);
  });

  it("opens the same account from a sealed file twice", async () => {
    const file = await backupOf(legacyBody(legacy("a")));
    const one = await openVaultFile(file, PASSWORD);
    const two = await openVaultFile(file, PASSWORD);
    expect(two).toEqual(one);
    expect(readVaultFile(file).tomb).toBe("personal");
  });
});

describe("merging legacy and migrated bodies", () => {
  const migrated = (id: string, updatedAt: string) =>
    normalizeVaultBody(legacyBody(legacy(id, updatedAt)));

  it("makes one account with no duplicate methods", () => {
    const merged = mergeVaultBodies(legacyBody(legacy("a")), migrated("a", T0));
    expect(merged.items.filter((item) => item.kind === "account")).toHaveLength(
      1,
    );
    expect(
      merged.items.filter((item) => item.kind === "credential"),
    ).toHaveLength(2);
    const account = accountOf(merged, "a");
    expect(account.methods.map((method) => method.id)).toEqual([
      "a:password",
      "a:authenticator",
    ]);
    expect(hasLegacyItems(merged)).toBe(false);
  });

  it("converges whichever side is the legacy one", () => {
    const left = legacyBody(legacy("a", T1), legacy("only-old"));
    const right = migrated("a", T1);
    expect(
      sameVaultContent(
        mergeVaultBodies(left, right),
        mergeVaultBodies(right, left),
      ),
    ).toBe(true);
    expect(
      mergeVaultBodies(left, right)
        .items.filter((item) => item.kind === "account")
        .map((i) => i.id)
        .sort(),
    ).toEqual(["a", "only-old"]);
  });

  it("lets a newer legacy login beat an older account by updatedAt", () => {
    const newer = Object.assign(legacy("a", T2), { password: "newer" });
    const merged = mergeVaultBodies(legacyBody(newer), migrated("a", T1));
    expect(passwordMethod(accountOf(merged, "a"))?.secret).toBe("newer");
    expect(accountOf(merged, "a").updatedAt).toBe(T2);
  });

  it("lets a newer account beat an older legacy login by updatedAt", () => {
    const older = Object.assign(legacy("a", T1), { password: "older" });
    const fresh = migrated("a", T2);
    const account = accountOf(fresh, "a");
    const edited: VaultItem = { ...account, username: "grace" };
    const merged = mergeVaultBodies(legacyBody(older), {
      ...fresh,
      items: [edited],
    });
    expect(accountOf(merged, "a").username).toBe("grace");
    expect(passwordMethod(accountOf(merged, "a"))?.secret).toBe("hunter2");
  });
});

describe("a pepper seal and a Sphinx key cross the whole path untouched", () => {
  async function peppered(): Promise<AccountItem> {
    const account = accountOf(
      normalizeVaultBody(legacyBody(legacy("p", T1))),
      "p",
    );
    const sealed = await sealWithPepper(
      "peppered-pw",
      "the pepper",
      pepperBinding("p", "p:password"),
    );
    return {
      ...account,
      methods: [
        {
          id: "p:password",
          type: "password",
          generator: { id: "manual" },
          pepper: true,
          secret: "",
          sealed,
          changedAt: T0,
        },
        {
          id: "p:password:sphinx",
          type: "password",
          generator: {
            id: "sphinx",
            rules: {
              length: 20,
              lower: true,
              upper: true,
              digits: true,
              symbols: true,
              avoidAmbiguous: false,
              minDigits: 0,
              minSymbols: 0,
            },
            realm: "example.com",
            counter: 3,
            oprfKeyB64: "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=",
          },
          pepper: true,
          secret: "",
          changedAt: T0,
        },
      ],
    };
  }

  it("survives seal, merge and backup byte-identically", async () => {
    const account = await peppered();
    const methodsJson = JSON.stringify(account.methods);
    const body: VaultBody = { ...emptyBody(), items: [account], rev: 2 };

    const merged = mergeVaultBodies(body, legacyBody(legacy("other")));
    expect(JSON.stringify(accountOf(merged, "p").methods)).toBe(methodsJson);

    const { vaultKey } = await createVault(PASSWORD);
    const binding = vaultSealBinding("personal", "body");
    const back = await openJson<VaultBody>(
      vaultKey,
      await sealJson(vaultKey, merged, binding),
      binding,
    );
    expect(JSON.stringify(accountOf(back, "p").methods)).toBe(methodsJson);

    const file = await backupOf(merged);
    const opened = await openVaultFile(file, PASSWORD);
    expect(opened.items.find((item) => item.id === "p")?.kind).toBe("account");
    // The file lists names and kinds, never a method's secret or key.
    expect(JSON.stringify(opened)).not.toContain("oprfKeyB64");
    expect(JSON.stringify(opened)).not.toContain("q83vEjRW");

    const sealed = accountOf(back, "p").methods.find(
      (method) => method.type === "password" && method.sealed,
    );
    if (sealed?.type !== "password" || !sealed.sealed)
      throw new Error("no PBKDF2 seal");
    await expect(
      openWithPepper(
        sealed.sealed,
        "the pepper",
        pepperBinding("p", "p:password"),
      ),
    ).resolves.toBe("peppered-pw");
  });
});
