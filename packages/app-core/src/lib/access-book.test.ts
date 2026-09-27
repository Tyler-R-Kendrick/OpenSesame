import { afterEach, describe, expect, it } from "vitest";
import {
  accessBookSeams,
  accessBookVersion,
  addLocalGrant,
  exportAccessBook,
  importAccessBook,
  listLocalGrants,
  removeLocalGrant,
  subscribeAccessBook,
} from "./access-book.js";

/** Let queued writes and their settles run. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

const original = { ...accessBookSeams };

describe("access book", () => {
  afterEach(async () => {
    // A write still settling would carry this test's book into the next.
    await flush();
    Object.assign(accessBookSeams, original);
  });

  it("adds, exports, imports, and removes grants on this device", () => {
    let stored: string | null = null;
    Object.assign(accessBookSeams, {
      read: () => stored,
      write: (raw: string) => {
        stored = raw;
      },
    });
    const grant = addLocalGrant({
      title: "Nightly deploy",
      expiresInSeconds: 7_200,
      mode: "relay",
    });
    expect(listLocalGrants().map((row) => row.title)).toEqual([
      "Nightly deploy",
    ]);
    expect(listLocalGrants()[0]?.mode).toBe("relay");
    const raw = exportAccessBook();
    expect(raw).toContain("Nightly deploy");
    removeLocalGrant(grant.id);
    expect(listLocalGrants()).toEqual([]);
    expect(importAccessBook(raw)).toEqual({ added: 1 });
    expect(importAccessBook(raw)).toEqual({ added: 0 });
  });

  it("reads its own write before storage settles it, and follows the settle", async () => {
    // The real seam: storage takes the value only once the durable write
    // settles, so a read in between saw the old book.
    let stored: string | null = null;
    const settles: (() => void)[] = [];
    Object.assign(accessBookSeams, {
      read: () => stored,
      write: (raw: string) =>
        new Promise<void>((resolve) => {
          settles.push(() => {
            stored = raw;
            resolve();
          });
        }),
    });
    const seen: number[] = [];
    const off = subscribeAccessBook(() => seen.push(listLocalGrants().length));
    const before = accessBookVersion();
    addLocalGrant({ title: "Nightly deploy" });
    expect(listLocalGrants().map((row) => row.title)).toEqual([
      "Nightly deploy",
    ]);
    expect(seen).toEqual([1]);
    expect(accessBookVersion()).toBe(before + 1);
    await flush();
    for (const settle of settles.splice(0)) settle();
    await flush();
    // Told again once storage holds it; the read now comes from storage.
    expect(seen).toEqual([1, 1]);
    expect(stored).toContain("Nightly deploy");
    off();
  });

  it("falls back to what storage holds when a write is refused", async () => {
    Object.assign(accessBookSeams, {
      read: () => null,
      write: () => Promise.reject(new Error("quota")),
    });
    const seen: number[] = [];
    const off = subscribeAccessBook(() => seen.push(listLocalGrants().length));
    addLocalGrant({ title: "Nightly deploy" });
    await flush();
    expect(seen).toEqual([1, 0]);
    expect(listLocalGrants()).toEqual([]);
    off();
  });

  it("imports every row in one write while a slow write is pending", async () => {
    let stored: string | null = null;
    let writes = 0;
    Object.assign(accessBookSeams, {
      read: () => stored,
      write: async (raw: string) => {
        writes += 1;
        await flush();
        stored = raw;
      },
    });
    const file = JSON.stringify({
      version: 1,
      grants: [{ title: "One" }, { title: "Two" }, { title: "Three" }],
    });
    expect(importAccessBook(file)).toEqual({ added: 3 });
    await flush();
    await flush();
    expect(writes).toBe(1);
    expect(listLocalGrants().map((row) => row.title)).toEqual([
      "One",
      "Two",
      "Three",
    ]);
  });

  it("skips junk rows and replaces a non-timestamp expiry", () => {
    let stored: string | null = null;
    Object.assign(accessBookSeams, {
      read: () => stored,
      write: (raw: string) => {
        stored = raw;
      },
    });
    expect(() => importAccessBook("{")).toThrow(/not an access book/i);
    expect(
      importAccessBook(
        JSON.stringify({
          grants: [
            { title: "   " },
            { id: "gr_local_x", title: "Keep", expiresAt: "soon" },
            { title: "Draft", mode: "relay", actions: ["read", 1] },
          ],
        }),
      ),
    ).toEqual({ added: 2 });
    const rows = listLocalGrants();
    const kept = rows.find((row) => row.title === "Keep");
    const draft = rows.find((row) => row.title === "Draft");
    expect(kept?.expiresAt.includes("T")).toBe(true);
    expect(Number.isFinite(Date.parse(kept?.expiresAt ?? ""))).toBe(true);
    expect(draft?.mode).toBe("relay");
    expect(draft?.actions).toEqual(["read"]);
  });
});
