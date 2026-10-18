import { BinaryWriter } from "@bufbuild/protobuf/wire";
import { afterEach, describe, expect, it } from "vitest";
import { importProtonKey, openProtonValue } from "./proton-pass-crypto.js";
import {
  type ProtonFolderRevision,
  createProtonFolderKeys,
} from "./proton-pass-folders.js";
import {
  envelope,
  itemBytes,
  protonFixture,
  shareKey,
} from "./proton-pass-http.fixture.js";
import { createProtonPassSessions } from "./proton-pass-session.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});
async function setup() {
  const fixture = await protonFixture();
  closes.push(fixture.close);
  const sessions = createProtonPassSessions(fixture.transport);
  const session = await sessions.authenticate({
    ...fixture.config,
    appVersion: "web-opensesame@0.1.0",
  });
  const signal = session.signal;
  if (!signal) throw new Error("Native session omitted its signal");
  const access = sessions.read(session);
  const owner = {
    signal,
    assertCurrent() {
      sessions.read(session);
      fixture.transport.assertCurrent();
    },
  };
  return {
    ...fixture,
    session,
    sessions,
    access,
    owner,
    key: createProtonFolderKeys(access, owner),
  };
}
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
      new BinaryWriter().tag(1, 2).string(id).finish(),
      raw,
      "foldercontent",
    ),
  };
}
const rootKey = new Uint8Array(32).fill(71);
const childKey = new Uint8Array(32).fill(72);
const leafKey = new Uint8Array(32).fill(73);

describe("native Proton encrypted folder chains over authenticated HTTP", () => {
  it("opens a nested child via old share rotation, parents and exact folder/item AAD domains", async () => {
    const f = await setup();
    f.state.pageSize = 1;
    f.state.folders.push(
      folder("leaf", "child", leafKey, childKey),
      folder("root", null, rootKey, shareKey(0)),
      folder("child", "root", childKey, rootKey),
    );
    const key = await f.key("leaf");
    expect(key.extractable).toBe(false);
    const itemRaw = new Uint8Array(32).fill(99);
    const openedItem = await openProtonValue(
      envelope(itemRaw, leafKey, "itemkey"),
      key,
      "itemkey",
      f.owner,
    );
    expect(openedItem).toEqual(itemRaw);
    const itemKey = await importProtonKey(openedItem, f.owner);
    const plaintext = itemBytes("Nested item", "login");
    expect(
      await openProtonValue(
        envelope(plaintext, itemRaw, "itemcontent"),
        itemKey,
        "itemcontent",
        f.owner,
      ),
    ).toEqual(plaintext);
    expect(
      f.state.requests
        .filter((r) => r.path.includes("/folder?"))
        .map((r) => r.path.split("?")[1]),
    ).toEqual(["PageSize=100", "PageSize=100&Since=1", "PageSize=100&Since=2"]);
    expect(f.state.requests.every((r) => !r.body.includes("Nested item"))).toBe(
      true,
    );
  });

  it("uses the current wrapping rotation for each root without confusing parent-key-wrapped children", async () => {
    const f = await setup();
    f.state.folders.push(
      folder("root", null, rootKey, shareKey(1), 1),
      folder("child", "root", childKey, rootKey, 1),
    );
    const opened = await f.key("child");
    expect(
      await openProtonValue(
        envelope(new Uint8Array([1, 2]), childKey, "foldercontent"),
        opened,
        "foldercontent",
        f.owner,
      ),
    ).toEqual(new Uint8Array([1, 2]));
    const count = f.state.requests.length;
    expect(await f.key("child")).toBe(opened);
    expect(f.state.requests).toHaveLength(count);
  });

  it.each([
    "missing",
    "cycle",
    "vault",
    "duplicate",
    "rotation",
    "key",
    "mac",
  ] as const)(
    "refuses an invalid %s chain without fallback keys or write egress",
    async (failure) => {
      const f = await setup();
      const root = folder("root", null, rootKey, shareKey(0));
      const child = folder("child", "root", childKey, rootKey);
      if (failure === "missing") child.ParentFolderID = "not-returned";
      if (failure === "cycle") root.ParentFolderID = "child";
      if (failure === "vault") child.VaultID = "different-vault";
      if (failure === "rotation") root.KeyRotation = 7;
      if (failure === "key")
        child.FolderKey = envelope(new Uint8Array(31), rootKey, "folderkey");
      if (failure === "mac") {
        const bytes = Buffer.from(child.FolderKey, "base64");
        bytes[bytes.length - 1] ^= 1;
        child.FolderKey = bytes.toString("base64");
      }
      f.state.folders.push(root, child);
      if (failure === "duplicate") f.state.folders.push(child);
      const writes = f.state.requests.filter((r) => r.method !== "GET").length;
      await expect(f.key("child")).rejects.toThrow();
      expect(f.state.requests.filter((r) => r.method !== "GET")).toHaveLength(
        writes,
      );
    },
  );

  it("refuses a repeated cursor instead of treating partial encrypted folders as complete", async () => {
    const f = await setup();
    f.state.pageSize = 1;
    f.state.repeatCursor = true;
    f.state.folders.push(
      folder("root", null, rootKey, shareKey(0)),
      folder("child", "root", childKey, rootKey),
      folder("leaf", "child", leafKey, childKey),
    );
    await expect(f.key("leaf")).rejects.toMatchObject({ code: "response" });
    expect(
      f.state.requests.filter((r) => r.path.includes("/folder?")).length,
    ).toBe(2);
  });

  it("bounds deep parent chains before opening any encrypted key", async () => {
    const f = await setup();
    for (let index = 0; index < 65; index += 1)
      f.state.folders.push(
        folder(
          `folder-${index}`,
          index ? `folder-${index - 1}` : null,
          rootKey,
          index ? rootKey : shareKey(0),
        ),
      );
    await expect(f.key("folder-64")).rejects.toMatchObject({
      code: "response",
    });
    expect(
      f.state.requests.filter((r) => r.path.includes("/folder?")).length,
    ).toBe(1);
  });

  it("withdraws a genuine held folder HTTP response without a second page or late key admission", async () => {
    const f = await setup();
    f.state.pageSize = 1;
    f.state.folders.push(
      folder("root", null, rootKey, shareKey(0)),
      folder("child", "root", childKey, rootKey),
    );
    f.state.hold = "GET /tenant/api/pass/v1/share/PAT%2Fshare/folder";
    const pending = f.key("child");
    const assertion = expect(pending).rejects.toThrow();
    await f.state.entered.promise;
    const count = f.state.requests.length;
    f.controller.abort();
    f.state.release.resolve();
    await assertion;
    await expect(f.key("child")).rejects.toThrow();
    expect(f.state.requests).toHaveLength(count);
  });

  it("refuses reuse of an operation-local decrypted folder key after exact native logout", async () => {
    const f = await setup();
    f.state.folders.push(folder("root", null, rootKey, shareKey(0)));
    await f.key("root");
    await f.sessions.disconnect(f.session);
    const count = f.state.requests.length;
    await expect(f.key("root")).rejects.toThrow();
    expect(f.state.requests).toHaveLength(count);
  });
});
