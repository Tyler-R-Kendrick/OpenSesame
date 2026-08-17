import { describe, expect, it } from "vitest";
import { createItem, type Folder } from "./model.js";
import {
  entryToVaultItem,
  joinStorePath,
  splitStorePath,
  vaultItemToEntry,
  entriesToVaultItems,
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
      item.totp =
        "otpauth://totp/Demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    }
    const entry = vaultItemToEntry(item, []);
    expect(entry.trailer).toMatch(/otpauth:\/\/totp\/Demo/);
  });
});
