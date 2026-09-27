import { afterEach, describe, expect, it } from "vitest";
import {
  accessBookSeams,
  addLocalGrant,
  exportAccessBook,
  importAccessBook,
  listLocalGrants,
  removeLocalGrant,
  subscribeAccessBook,
} from "./access-book.js";

const original = { ...accessBookSeams };

describe("access book", () => {
  afterEach(() => {
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

  it("tells a subscriber after every write, until it unsubscribes", () => {
    let stored: string | null = null;
    Object.assign(accessBookSeams, {
      read: () => stored,
      write: (raw: string) => {
        stored = raw;
      },
    });
    const seen: number[] = [];
    const off = subscribeAccessBook(() => seen.push(listLocalGrants().length));
    const grant = addLocalGrant({ title: "Nightly deploy" });
    const raw = exportAccessBook();
    removeLocalGrant(grant.id);
    importAccessBook(raw);
    // The listener runs after the write, so it reads the book as written.
    expect(seen).toEqual([1, 0, 1]);
    off();
    removeLocalGrant(grant.id);
    expect(seen).toEqual([1, 0, 1]);
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
