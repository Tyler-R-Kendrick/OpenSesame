import { describe, expect, it } from "vitest";
import { type Folder, createItem } from "./model.js";
import {
  entriesToVaultItems,
  entryToVaultItem,
  joinStorePath,
  planManifestMerge,
  splitStorePath,
  vaultItemToEntry,
} from "./store-sync.js";

describe("store-sync mapping", () => {
  it("maps Folder/name to folder + name", () => {
    expect(splitStorePath("Email/github.com")).toEqual({
      folder: "Email",
      name: "github.com",
    });
    expect(joinStorePath("Email", "github.com")).toBe("Email/github.com");
  });

  it("maps entry to login vault item", () => {
    const item = entryToVaultItem({
      path: "Email/github.com",
      secret: "x",
      trailer: JSON.stringify({ kind: "login", username: "ada" }),
    });
    expect(item.name).toBe("github.com");
    expect(item.kind).toBe("login");
    if (item.kind === "login") {
      expect(item.password).toBe("x");
      expect(item.username).toBe("ada");
    }
  });

  it("round-trips a login through vaultItemToEntry", () => {
    const folders: Folder[] = [
      { id: "f1", name: "Email", createdAt: new Date().toISOString() },
    ];
    const item = createItem("login", "github.com");
    item.folderId = "f1";
    if (item.kind === "login") {
      item.password = "hunter2";
      item.username = "ada";
    }
    const entry = vaultItemToEntry(item, folders);
    expect(entry.path).toBe("Email/github.com");
    expect(entry.secret).toBe("hunter2");
    const back = entryToVaultItem(entry, "f1");
    expect(back.kind).toBe("login");
    if (back.kind === "login") {
      expect(back.password).toBe("hunter2");
      expect(back.username).toBe("ada");
    }
  });

  it("maps pass-otp trailer otpauth into login.totp", () => {
    const item = entryToVaultItem({
      path: "Email/site",
      secret: "pw",
      trailer:
        'otpauth://totp/Demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ\n{"kind":"login","username":"a"}\n',
    });
    expect(item.kind).toBe("login");
    if (item.kind === "login") {
      expect(item.totp).toMatch(/^otpauth:\/\//);
      expect(item.username).toBe("a");
    }
  });

  it("writes otpauth into the trailer for store interop", () => {
    const item = createItem("login", "site");
    if (item.kind === "login") {
      item.password = "pw";
      item.totp = "otpauth://totp/Demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    }
    const entry = vaultItemToEntry(item, []);
    expect(entry.trailer).toMatch(/otpauth:\/\/totp\/Demo/);
  });
});

describe("planManifestMerge", () => {
  const folders: Folder[] = [
    { id: "f1", name: "Email", createdAt: new Date().toISOString() },
  ];

  function existingLogin() {
    const item = createItem("login", "github.com");
    item.folderId = "f1";
    if (item.kind === "login") {
      item.password = "old";
      item.username = "ada";
    }
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
    if (updated?.kind === "login") {
      expect(updated.password).toBe("rotated");
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
