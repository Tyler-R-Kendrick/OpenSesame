import { afterEach, describe, expect, it } from "vitest";
import type { ProtonFolderRevision } from "./proton-pass-folders.js";
import {
  envelope,
  open,
  protonFixture,
  seeded,
  shareKey,
} from "./proton-pass-http.fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const rootRaw = new Uint8Array(32).fill(71);
const childRaw = new Uint8Array(32).fill(72);
function folder(
  id: string,
  parent: string | null,
  raw: Uint8Array,
  wrapping: Uint8Array,
  rotation = 0,
): ProtonFolderRevision {
  return {
    VaultID: "vault",
    FolderID: id,
    ParentFolderID: parent,
    KeyRotation: rotation,
    FolderKey: envelope(raw, wrapping, "folderkey"),
    ContentFormatVersion: 1,
    Content: envelope(
      Uint8Array.of(10, 4, 110, 97, 109, 101),
      raw,
      "foldercontent",
    ),
  };
}
async function setup() {
  const f = await protonFixture();
  cleanups.push(f.close);
  f.state.folders.push(
    folder("root", null, rootRaw, shareKey(0)),
    folder("child", "root", childRaw, rootRaw),
  );
  for (const id of ["first", "second"]) {
    const item = seeded(id, id, 0, "login");
    item.FolderID = "child";
    item.ItemKey = envelope(new Uint8Array(32).fill(90), childRaw, "itemkey");
    f.state.items.set(id, item);
  }
  const session = await f.backend.authenticate(f.config);
  return { ...f, session };
}

describe("native Proton folder items through the common SecretBackend", () => {
  it("lists and gets nested encrypted items using one complete operation-local folder snapshot", async () => {
    const f = await setup();
    const count = f.state.requests.filter((r) =>
      r.path.includes("/folder?"),
    ).length;
    expect(await f.backend.listItems(f.session)).toEqual([
      { id: "first", name: "first", kind: "login" },
      { id: "second", name: "second", kind: "login" },
    ]);
    expect(
      f.state.requests.filter((r) => r.path.includes("/folder?")),
    ).toHaveLength(count + 1);
    expect(await f.backend.getNotes("first", f.session)).toBe("fixture note");
    expect((await f.backend.getItem("second", f.session)).secret).toBe(
      "fixture password",
    );
  });

  it("updates a nested login without changing its folder, wrapped item key or unknown spans", async () => {
    const f = await setup();
    const input = {
      name: "Changed nested",
      notes: "changed notes",
      secret: "changed password",
      kind: "login" as const,
      username: "changed user",
      url: "https://changed.test",
    };
    const originalWrap = f.state.items.get("first")?.ItemKey;
    const updated = await f.backend.updateItem("first", input, f.session);
    expect(updated).toMatchObject(input);
    const stored = f.state.items.get("first");
    if (!stored?.ItemKey) throw new Error("Missing stored nested item");
    expect(stored.FolderID).toBe("child");
    expect(stored.KeyRotation).toBe(0);
    expect(stored.ItemKey).toBe(originalWrap);
    const itemRaw = open(stored.ItemKey, childRaw, "itemkey");
    const plain = open(stored.Content, itemRaw, "itemcontent");
    expect(Buffer.from(plain).includes(Buffer.from("changed password"))).toBe(
      true,
    );
    expect(Buffer.from(plain).includes(Buffer.from("unknown-preserved"))).toBe(
      true,
    );
    expect(Buffer.from(plain).includes(Buffer.from("root-preserved"))).toBe(
      true,
    );
    expect(Buffer.from(plain).includes(Buffer.from("retain@email.test"))).toBe(
      true,
    );
    expect(
      f.state.requests.find((r) => r.method === "PUT")?.body,
    ).not.toContain(input.secret);
  });

  it("reads a fresh folder wrapping rotation on the next operation instead of retaining old keys", async () => {
    const f = await setup();
    expect((await f.backend.getItem("first", f.session)).name).toBe("first");
    const newRoot = new Uint8Array(32).fill(74);
    f.state.folders.splice(
      0,
      2,
      folder("root", null, newRoot, shareKey(1), 1),
      folder("child", "root", childRaw, newRoot, 1),
    );
    const count = f.state.requests.filter((r) =>
      r.path.includes("/folder?"),
    ).length;
    expect((await f.backend.getItem("first", f.session)).name).toBe("first");
    expect(
      f.state.requests.filter((r) => r.path.includes("/folder?")),
    ).toHaveLength(count + 1);
    expect(f.state.items.get("first")?.KeyRotation).toBe(0);
  });

  it("removes a nested item using the real trash revision and keeps the sibling intact", async () => {
    const f = await setup();
    await f.backend.deleteItem("first", f.session);
    expect(f.state.items.get("first")?.State).toBe(2);
    expect(await f.backend.listItems(f.session)).toEqual([
      { id: "second", name: "second", kind: "login" },
    ]);
    expect((await f.backend.getItem("second", f.session)).name).toBe("second");
  });

  it("never changes encrypted nested content when the required parent chain is missing", async () => {
    const f = await setup();
    f.state.folders.splice(0, 1);
    const original = f.state.items.get("first")?.Content;
    const writes = f.state.requests.filter((r) => r.method !== "GET").length;
    await expect(
      f.backend.updateItem(
        "first",
        { name: "Changed", notes: "", secret: "", kind: "login" },
        f.session,
      ),
    ).rejects.toThrow();
    await expect(f.backend.listItems(f.session)).rejects.toThrow();
    expect(f.state.items.get("first")?.Content).toBe(original);
    expect(f.state.requests.filter((r) => r.method !== "GET")).toHaveLength(
      writes,
    );
  });

  it("withdraws a real held folder response before nested content decrypt or mutation", async () => {
    const f = await setup();
    f.state.pageSize = 1;
    const original = f.state.items.get("first")?.Content;
    f.state.hold = "GET /tenant/api/pass/v1/share/PAT%2Fshare/folder";
    const pending = f.backend.updateItem(
      "first",
      { name: "Changed", notes: "", secret: "new", kind: "login" },
      f.session,
    );
    const assertion = expect(pending).rejects.toThrow();
    await f.state.entered.promise;
    const count = f.state.requests.length;
    f.controller.abort();
    f.state.release.resolve();
    await assertion;
    await expect(f.backend.listItems(f.session)).rejects.toThrow();
    expect(f.state.requests).toHaveLength(count);
    expect(f.state.requests.some((r) => r.method === "PUT")).toBe(false);
    expect(f.state.items.get("first")?.Content).toBe(original);
  });
});
