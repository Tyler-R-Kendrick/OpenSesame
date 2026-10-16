import { BinaryReader } from "@bufbuild/protobuf/wire";
import { afterEach, describe, expect, it } from "vitest";
import {
  accessToken,
  envelope,
  openStored,
  protonFixture,
  seeded,
  shareKey,
  tokenHalf,
} from "./proton-pass-http.fixture.js";
import type { SecretBackend, SecretBackendItemInput } from "./types.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function setup() {
  const fixture = await protonFixture();
  cleanups.push(fixture.close);
  return fixture;
}
function textFields(bytes: Uint8Array, target: number): string[] {
  const reader = new BinaryReader(bytes);
  const values: string[] = [];
  while (reader.pos < reader.len) {
    const [field, wire] = reader.tag();
    if (field === target && wire === 2) values.push(reader.string());
    else reader.skip(wire);
  }
  return values;
}
function message(bytes: Uint8Array, target: number): Uint8Array {
  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const [field, wire] = reader.tag();
    if (field === target && wire === 2) return reader.bytes();
    reader.skip(wire);
  }
  throw new Error("Missing independent fixture message");
}
const note: SecretBackendItemInput = {
  name: "Backup",
  notes: "encrypted snapshot data 🔐",
  secret: "",
  kind: "note",
};
const login: SecretBackendItemInput = {
  name: "Login",
  notes: "changed note",
  secret: "changed password",
  kind: "login",
  username: "changed user",
  url: "https://changed.test",
};

describe("native Proton encrypted SecretBackend over HTTP", () => {
  it("authenticates using the actual PAT split and scoped session headers", async () => {
    const f = await setup();
    const session = await f.backend.authenticate(f.config);
    const common: SecretBackend = f.backend;
    expect(common.capabilities.vaultBackup).toEqual({
      kind: "note",
      field: "notes",
      maxBytes: 768 * 1024,
    });
    expect(JSON.parse(f.state.requests[0]?.body ?? "{}")).toEqual({
      Token: tokenHalf,
    });
    expect(
      f.state.requests
        .slice(1)
        .every((r) => r.headers.authorization === `Bearer ${accessToken}`),
    ).toBe(true);
    expect(
      f.state.requests.every(
        (r) => r.headers["x-pm-appversion"] === "web-opensesame@0.1.0",
      ),
    ).toBe(true);
    expect(JSON.stringify(session)).not.toContain(accessToken);
    expect(JSON.stringify(f.state.requests)).not.toContain(f.config.token);
  });

  it.each([note, login])(
    "creates real encrypted $kind and independently opens the exact request",
    async (input) => {
      const f = await setup();
      const session = await f.backend.authenticate(f.config);
      const created = await f.backend.createItem(input, session);
      expect(created).toMatchObject(input);
      const stored = f.state.items.get(created.id);
      if (!stored) throw new Error("Missing created item");
      expect(stored.KeyRotation).toBe(1);
      const bytes = openStored(stored);
      expect(textFields(message(bytes, 1), 1)).toEqual([input.name]);
      expect(textFields(message(bytes, 1), 2)).toEqual([input.notes]);
      if (input.kind === "login")
        expect(textFields(message(message(bytes, 2), 3), 2)).toEqual([
          input.secret,
        ]);
      const sent = f.state.requests.find(
        (r) => r.method === "POST" && r.path.endsWith("/item"),
      );
      expect(sent?.body).not.toContain(input.notes);
      if (input.secret) expect(sent?.body).not.toContain(input.secret);
      expect(await f.backend.getItem(created.id, session)).toEqual(created);
      expect(await f.backend.getNotes(input.name, session)).toBe(input.notes);
    },
  );

  it("lists all encrypted pages, omits trash and resolves exact IDs before ambiguous names", async () => {
    const f = await setup();
    f.state.pageSize = 1;
    f.state.items.set("id/α", seeded("id/α", "same"));
    f.state.items.set("other", seeded("other", "same", 1, "login"));
    const trash = seeded("trash", "hidden");
    trash.State = 2;
    f.state.items.set("trash", trash);
    const session = await f.backend.authenticate(f.config);
    expect(await f.backend.listItems(session)).toEqual([
      { id: "id/α", name: "same", kind: "note" },
      { id: "other", name: "same", kind: "login" },
    ]);
    expect((await f.backend.getItem("id/α", session)).id).toBe("id/α");
    await expect(f.backend.getItem("same", session)).rejects.toMatchObject({
      code: "ambiguous",
    });
    await expect(f.backend.getItem("absent", session)).rejects.toMatchObject({
      code: "not-found",
    });
    expect(f.state.requests.some((r) => r.path.includes("Since=1"))).toBe(true);
    expect(
      f.state.requests.some((r) => r.path.endsWith("item/id%2F%CE%B1")),
    ).toBe(true);
  });

  it("updates old-rotation login using LastRevision and preserves unknown fields, email and item key", async () => {
    const f = await setup();
    const original = seeded("old", "Before", 0, "login");
    f.state.items.set("old", original);
    const originalWrap = original.ItemKey;
    const session = await f.backend.authenticate(f.config);
    const updated = await f.backend.updateItem("old", login, session);
    expect(updated).toMatchObject(login);
    const stored = f.state.items.get("old");
    if (!stored) throw new Error("Missing updated item");
    expect(stored.KeyRotation).toBe(0);
    expect(stored.ItemKey).toBe(originalWrap);
    const bytes = openStored(stored);
    expect(textFields(bytes, 101)).toEqual(["root-preserved"]);
    const content = message(message(bytes, 2), 3);
    expect(textFields(content, 100)).toEqual(["unknown-preserved"]);
    expect(textFields(content, 1)).toEqual(["retain@email.test"]);
    const put = f.state.requests.find((r) => r.method === "PUT");
    expect(JSON.parse(put?.body ?? "{}")).toMatchObject({
      LastRevision: 4,
      KeyRotation: 0,
      ContentFormatVersion: 7,
    });
    expect(put?.body).not.toContain(login.secret);
  });

  it("trashes using the actual revision protocol and no permanent DELETE", async () => {
    const f = await setup();
    f.state.items.set("remove", seeded("remove", "remove"));
    const session = await f.backend.authenticate(f.config);
    await f.backend.deleteItem("remove", session);
    expect(f.state.items.get("remove")?.State).toBe(2);
    const sent = f.state.requests.find((r) => r.path.endsWith("/item/trash"));
    expect(sent?.method).toBe("POST");
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({
      Items: [{ ItemID: "remove", Revision: 4 }],
    });
    expect(f.state.requests.some((r) => r.method === "DELETE")).toBe(false);
    expect(await f.backend.listItems(session)).toEqual([]);
    await expect(f.backend.getItem("remove", session)).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("does not accept replayed valid ciphertext as a newly created backup", async () => {
    const f = await setup();
    f.state.response.created = seeded("replay", "Unrelated", 1);
    const session = await f.backend.authenticate(f.config);
    await expect(f.backend.createItem(note, session)).rejects.toMatchObject({
      code: "response",
    });
    expect(
      f.state.requests.filter(
        (r) => r.method === "POST" && r.path.endsWith("/item"),
      ),
    ).toHaveLength(1);
  });

  it.each(["update", "delete"] as const)(
    "does not retry or overwrite an optimistic %s conflict",
    async (operation) => {
      const f = await setup();
      f.state.items.set("old", seeded("old", "Before"));
      const original = f.state.items.get("old")?.Content;
      const session = await f.backend.authenticate(f.config);
      f.state.conflict = true;
      await expect(
        operation === "update"
          ? f.backend.updateItem("old", { ...note, name: "After" }, session)
          : f.backend.deleteItem("old", session),
      ).rejects.toMatchObject({ code: "stale" });
      expect(f.state.items.get("old")?.Content).toBe(original);
      expect(
        f.state.requests.filter(
          (r) => r.method === "PUT" || r.path.endsWith("/item/trash"),
        ),
      ).toHaveLength(1);
    },
  );

  it("refuses all viewer mutations before egress while preserving real read access", async () => {
    const f = await setup();
    f.state.role = "3";
    f.state.items.set("old", seeded("old", "Before"));
    const session = await f.backend.authenticate(f.config);
    expect(await f.backend.getNotes("old", session)).toBe("fixture note");
    const count = f.state.requests.length;
    await expect(f.backend.createItem(note, session)).rejects.toMatchObject({
      code: "authentication",
    });
    await expect(
      f.backend.updateItem("old", note, session),
    ).rejects.toMatchObject({ code: "authentication" });
    await expect(f.backend.deleteItem("old", session)).rejects.toMatchObject({
      code: "authentication",
    });
    expect(f.state.requests).toHaveLength(count);
  });

  it.each(["wrong-key", "bad-mac", "malformed"] as const)(
    "refuses %s ciphertext before any write",
    async (failure) => {
      const f = await setup();
      const item = seeded("old", "Before");
      if (failure === "wrong-key")
        item.ItemKey = envelope(
          new Uint8Array(32).fill(91),
          shareKey(0),
          "itemkey",
        );
      if (failure === "bad-mac") {
        const bytes = Buffer.from(item.Content, "base64");
        bytes[bytes.length - 1] ^= 1;
        item.Content = bytes.toString("base64");
      }
      if (failure === "malformed")
        item.Content = envelope(
          Uint8Array.of(10, 127, 1),
          new Uint8Array(32).fill(90),
          "itemcontent",
        );
      f.state.items.set("old", item);
      const session = await f.backend.authenticate(f.config);
      const count = f.state.requests.filter((r) => r.method !== "GET").length;
      await expect(
        f.backend.updateItem("old", note, session),
      ).rejects.toThrow();
      expect(f.state.requests.filter((r) => r.method !== "GET")).toHaveLength(
        count,
      );
    },
  );

  it("rejects missing rotations, unsafe revisions and repeated page cursors without partial success", async () => {
    const f = await setup();
    const item = seeded("old", "Before");
    item.KeyRotation = 7;
    f.state.items.set("old", item);
    const session = await f.backend.authenticate(f.config);
    await expect(f.backend.getItem("old", session)).rejects.toThrow();
    item.KeyRotation = 0;
    item.Revision = Number.MAX_SAFE_INTEGER + 1;
    await expect(f.backend.getItem("old", session)).rejects.toMatchObject({
      code: "response",
    });
    item.Revision = 4;
    f.state.pageSize = 1;
    f.state.repeatCursor = true;
    f.state.items.set("second", seeded("second", "second"));
    f.state.items.set("third", seeded("third", "third"));
    await expect(f.backend.listItems(session)).rejects.toMatchObject({
      code: "response",
    });
  });

  it.each(["folder", "missing-key"] as const)(
    "does not claim a writable %s item without its required key material",
    async (boundary) => {
      const f = await setup();
      const item = seeded("old", "Before");
      if (boundary === "folder") item.FolderID = "encrypted-folder";
      else item.ItemKey = null;
      f.state.items.set("old", item);
      const session = await f.backend.authenticate(f.config);
      const count = f.state.requests.filter((r) => r.method !== "GET").length;
      await expect(
        f.backend.updateItem("old", note, session),
      ).rejects.toThrow();
      await expect(f.backend.listItems(session)).rejects.toThrow();
      expect(f.state.requests.filter((r) => r.method !== "GET")).toHaveLength(
        count,
      );
    },
  );

  it("rejects a cloned opaque handle before any authenticated request", async () => {
    const f = await setup();
    const session = await f.backend.authenticate(f.config);
    const forged = { ...session };
    const count = f.state.requests.length;
    await expect(f.backend.createItem(note, forged)).rejects.toThrow();
    await expect(f.backend.listItems(forged)).rejects.toThrow();
    expect(f.state.requests).toHaveLength(count);
  });

  it("withdraws on actual 401 and prevents all authenticated followups", async () => {
    const f = await setup();
    const session = await f.backend.authenticate(f.config);
    f.state.unauthorized = true;
    await expect(f.backend.listItems(session)).rejects.toThrow();
    expect(session.signal?.aborted).toBe(true);
    const count = f.state.requests.length;
    await expect(f.backend.createItem(note, session)).rejects.toThrow();
    await expect(f.backend.listItems(session)).rejects.toThrow();
    expect(f.state.requests).toHaveLength(count);
  });

  it.each(["disconnect", "owner"] as const)(
    "withdraws a real held update response on %s without a late GET",
    async (reason) => {
      const f = await setup();
      f.state.items.set("old", seeded("old", "Before"));
      const session = await f.backend.authenticate(f.config);
      f.state.hold = "PUT /tenant/api/pass/v1/share/PAT%2Fshare/item/old";
      const pending = f.backend.updateItem("old", note, session);
      const assertion = expect(pending).rejects.toThrow();
      await f.state.entered.promise;
      const count = f.state.requests.length;
      if (reason === "disconnect") await f.backend.disconnect(session);
      else f.controller.abort();
      f.state.release.resolve();
      await assertion;
      await expect(f.backend.listItems(session)).rejects.toThrow();
      expect(f.state.requests).toHaveLength(count);
    },
  );
});
