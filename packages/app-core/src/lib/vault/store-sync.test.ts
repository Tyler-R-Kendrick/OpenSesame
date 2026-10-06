import {
  type AccountItem,
  type Folder,
  accountTotp,
  authenticatorMethod,
  createItem,
  passwordMethod,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { typePassword } from "../account.test-support.js";
import { producedPassword } from "../account.test-support.js";
import {
  entryToVaultItem,
  filterEntriesForProject,
  joinStorePath,
  planManifestMerge,
  sealedBytesToSyncBlobs,
  splitStorePath,
  vaultItemToEntry,
} from "./store-sync.js";

/** An account holding `password` as a typed password method, and an optional seed. */
function account(name: string, password: string, totp = ""): AccountItem {
  const item = createItem("account", name);
  const method = passwordMethod(item);
  if (method) typePassword(method, password);
  if (totp) {
    item.methods.push({
      id: `${item.id}:authenticator`,
      type: "authenticator",
      secret: totp,
    });
  }
  return item;
}

describe("store-sync mapping", () => {
  it("maps Folder/name to folder + name", () => {
    expect(splitStorePath("Email/github.com")).toEqual({
      folder: "Email",
      name: "github.com",
    });
    expect(joinStorePath("Email", "github.com")).toBe("Email/github.com");
  });

  it("maps a first-format login entry to an account", () => {
    const item = entryToVaultItem({
      path: "Email/github.com",
      secret: "x",
      trailer: JSON.stringify({ kind: "login", username: "ada" }),
    });
    expect(item.name).toBe("github.com");
    expect(item.kind).toBe("account");
    if (item.kind === "account") {
      expect(producedPassword(item)).toBe("x");
      expect(item.username).toBe("ada");
      expect(item.methods.map((m) => m.id)).toEqual([`${item.id}:password`]);
    }
  });

  it("round-trips an account through vaultItemToEntry", () => {
    const folders: Folder[] = [
      { id: "f1", name: "Email", createdAt: new Date().toISOString() },
    ];
    const item = account("github.com", "hunter2");
    item.folderId = "f1";
    item.username = "ada";
    const entry = vaultItemToEntry(item, folders);
    expect(entry.path).toBe("Email/github.com");
    expect(entry.secret).toBe("hunter2");
    // Line one carries the password; the trailer does not repeat it.
    expect(entry.trailer).not.toContain("hunter2");
    const back = entryToVaultItem(entry, "f1");
    expect(back.kind).toBe("account");
    if (back.kind === "account") {
      expect(producedPassword(back)).toBe("hunter2");
      expect(back.username).toBe("ada");
      expect(back.methods).toEqual(item.methods);
    }
  });

  it("maps pass-otp trailer otpauth into the first authenticator", () => {
    const item = entryToVaultItem({
      path: "Email/site",
      secret: "pw",
      trailer:
        'otpauth://totp/Demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ\n{"kind":"login","username":"a"}\n', // gitleaks:allow -- RFC fixture
    });
    expect(item.kind).toBe("account");
    if (item.kind === "account") {
      expect(accountTotp(item)).toMatch(/^otpauth:\/\//);
      expect(item.username).toBe("a");
      expect(authenticatorMethod(item)?.id).toBe(`${item.id}:authenticator`);
    }
  });

  it("writes otpauth into the trailer for store interop", () => {
    const item = account(
      "site",
      "pw",
      "otpauth://totp/Demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", // gitleaks:allow -- RFC fixture
    );
    const entry = vaultItemToEntry(item, []);
    expect(entry.trailer).toMatch(/otpauth:\/\/totp\/Demo/);
    // The bare line is the seed's one home in the entry.
    expect(entry.trailer.match(/otpauth:\/\//gu)).toHaveLength(1);
    const back = entryToVaultItem(entry);
    if (back.kind !== "account") throw new Error("expected an account");
    expect(back.methods).toEqual(item.methods);
  });

  it("filters store entries to a project folder", () => {
    const entries = [
      { path: "personal/api", secret: "a", trailer: "{}" },
      { path: "work/api", secret: "b", trailer: "{}" },
      { path: "orphan", secret: "c", trailer: "{}" },
    ];
    expect(
      filterEntriesForProject(entries, "personal").map((e) => e.path),
    ).toEqual(["personal/api"]);
    expect(filterEntriesForProject(entries, null)).toHaveLength(3);
  });

  it("maps sealed bytes to opaque sync blobs without plaintext", () => {
    // Blob ids reach the Host verbatim, so they must carry no store path.
    const id = "project:p1:0f3a9c";
    const blobs = sealedBytesToSyncBlobs([
      { id, epoch: 4, ciphertext: new Uint8Array([1, 2, 3]) },
    ]);
    expect(blobs[0]?.ciphertextB64).toBe(btoa("\u0001\u0002\u0003"));
    expect(() =>
      sealedBytesToSyncBlobs([
        { id: "x", epoch: 1, ciphertext: new Uint8Array() },
      ]),
    ).toThrow(/empty ciphertext/);
  });
});

describe("planManifestMerge", () => {
  const folders: Folder[] = [
    { id: "f1", name: "Email", createdAt: new Date().toISOString() },
  ];

  function existingLogin() {
    const item = account("github.com", "old");
    item.folderId = "f1";
    item.username = "ada";
    return item;
  }

  it("re-importing the same manifest is idempotent, not a duplicate", () => {
    const current = existingLogin();
    const manifest = [vaultItemToEntry(current, folders)];
    const plan = planManifestMerge(manifest, [current], folders);
    expect(plan.adds).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
    expect(plan.newFolders).toHaveLength(0);
  });

  it("updates an existing item in place when the secret changed", () => {
    const current = existingLogin();
    const entry = vaultItemToEntry(current, folders);
    const plan = planManifestMerge(
      [{ ...entry, secret: "rotated" }],
      [current],
      folders,
    );
    expect(plan.adds).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
    const updated = plan.updates[0];
    expect(updated?.id).toBe(current.id);
    expect(updated?.createdAt).toBe(current.createdAt);
    if (updated?.kind === "account") {
      expect(producedPassword(updated)).toBe("rotated");
      // The method keeps its id: it is the same password, rotated.
      expect(updated.methods.map((m) => m.id)).toEqual(
        current.methods.map((m) => m.id),
      );
    }
  });

  it("adds unseen paths with their new folders", () => {
    const current = existingLogin();
    const plan = planManifestMerge(
      [
        {
          path: "Work/api",
          secret: "t",
          trailer: JSON.stringify({ kind: "secret" }),
        },
      ],
      [current],
      folders,
    );
    expect(plan.adds).toHaveLength(1);
    expect(plan.updates).toHaveLength(0);
    expect(plan.newFolders.map((f) => f.name)).toEqual(["Work"]);
  });

  it("a trashed item does not block re-adding its path", () => {
    const current = existingLogin();
    current.deletedAt = new Date().toISOString();
    const entry = vaultItemToEntry(current, folders);
    const plan = planManifestMerge([entry], [current], folders);
    expect(plan.adds).toHaveLength(1);
  });
});
