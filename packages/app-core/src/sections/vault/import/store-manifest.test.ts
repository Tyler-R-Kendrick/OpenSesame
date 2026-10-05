import {
  type Folder,
  accountPlainPassword,
  createItem,
  manualPassword,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { vaultItemToEntry } from "../../../lib/vault/store-sync.js";
import {
  STORE_MANIFEST_LABEL,
  manifestCommitLabel,
  manifestFacts,
  planStoreManifest,
  readStoreManifest,
  storeManifestFile,
} from "./store-manifest.js";

const DEV: Folder = {
  id: "fld_dev",
  name: "Dev",
  createdAt: "2026-01-01T00:00:00Z",
};

describe("readStoreManifest", () => {
  it("reads an array of { path, secret, trailer }, trailer optional", () => {
    expect(
      readStoreManifest([
        { path: "Dev/a", secret: "1", trailer: '{"kind":"login"}\n' },
        { path: "b", secret: "2" },
      ]),
    ).toEqual([
      { path: "Dev/a", secret: "1", trailer: '{"kind":"login"}\n' },
      { path: "b", secret: "2", trailer: "" },
    ]);
  });

  it("is not another format's JSON", () => {
    for (const json of [
      null,
      [],
      { path: "a", secret: "1" },
      [{ path: "a", secret: "1", username: "x" }],
      [{ name: "a", password: "1" }],
      [{ path: "", secret: "1" }],
      [{ path: "//", secret: "1" }],
      [{ path: "a", secret: 1 }],
      [{ path: "a", secret: "1", trailer: 3 }],
      [{ path: "a", secret: "1" }, "b"],
      { items: [], folders: [] },
    ]) {
      expect(readStoreManifest(json), JSON.stringify(json)).toBeNull();
    }
  });

  it("keeps the last entry for a path named twice, as pass seal would", () => {
    expect(
      readStoreManifest([
        { path: "Dev/a", secret: "old" },
        { path: "b", secret: "b" },
        { path: "/dev/A/", secret: "new" },
      ]),
    ).toEqual([
      { path: "b", secret: "b", trailer: "" },
      { path: "/dev/A/", secret: "new", trailer: "" },
    ]);
  });
});

describe("planStoreManifest", () => {
  it("rewrites an account at its path in place, and adds what is new", () => {
    const current = { ...createItem("account", "a"), folderId: DEV.id };
    current.methods = [manualPassword(`${current.id}:password`, "old", "x")];
    const plan = planStoreManifest(
      [
        { path: "Dev/a", secret: "new", trailer: '{"kind":"login"}\n' },
        { path: "Dev/b", secret: "b", trailer: "" },
      ],
      [current],
      [DEV],
    );
    expect(plan.adds.map((item) => item.name)).toEqual(["b"]);
    expect(plan.updates).toHaveLength(1);
    const updated = plan.updates[0];
    if (updated?.kind !== "account") throw new Error("expected an account");
    expect(updated.id).toBe(current.id);
    expect(accountPlainPassword(updated)).toBe("new");
    expect(plan.kept).toBe(0);
    expect(manifestCommitLabel(plan)).toBe("Merge 2 entries");
  });

  it("counts a trailer that says the same thing in other words as unchanged", () => {
    const current = createItem("account", "GitHub");
    current.username = "octo";
    current.methods = [manualPassword(`${current.id}:password`, "pw", "x")];
    const plan = planStoreManifest(
      [
        {
          path: "GitHub",
          secret: "pw",
          trailer: '{"kind":"login","username":"octo"}\n',
        },
      ],
      [current],
      [],
    );
    expect(plan).toMatchObject({ adds: [], updates: [], unchanged: 1 });
  });

  it("rewrites a card at its path as a card, every other value intact", () => {
    const card = createItem("card", "Travel card");
    card.number = "4111111111111111";
    card.cardholder = "A. Rowan";
    card.code = "123";
    const entry = { ...vaultItemToEntry(card, []), secret: "4000" };
    const plan = planStoreManifest([entry], [card], []);
    expect(plan.kept).toBe(0);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toMatchObject({
      id: card.id,
      kind: "card",
      number: "4000",
      cardholder: "A. Rowan",
      code: "123",
    });
  });

  it("never turns a card at a path into an account", () => {
    const card = createItem("card", "Travel card");
    card.number = "4111111111111111";
    // A bare `pass` entry names no kind, so it reads as an account.
    const entry = { path: "Travel card", secret: "4000", trailer: "" };
    const plan = planStoreManifest([entry], [card], []);
    expect(plan.updates).toEqual([]);
    expect(plan.kept).toBe(1);
    expect(manifestCommitLabel(plan)).toBe("Nothing to merge");
    expect(manifestFacts([entry], plan)).toContainEqual({
      key: "Kept as is",
      value: "1",
    });
  });

  it("states the format, the entries and what the merge writes", () => {
    const entries = [{ path: "x", secret: "1", trailer: "" }];
    const plan = planStoreManifest(entries, [], []);
    expect(manifestFacts(entries, plan)).toEqual([
      { key: "Format", value: STORE_MANIFEST_LABEL },
      { key: "Entries", value: "1" },
      { key: "New", value: "1" },
    ]);
    expect(manifestCommitLabel(plan)).toBe("Merge 1 entry");
  });
});

describe("storeManifestFile", () => {
  it("writes live items only, as a JSON array pass seal reads", () => {
    const real = createItem("secret", "Token");
    real.value = "t0k3n"; // gitleaks:allow -- fixture
    const trashed = {
      ...createItem("account", "Old"),
      deletedAt: "2026-01-01T00:00:00Z",
    };
    const file = storeManifestFile(
      [real, trashed],
      [],
      new Date("2026-09-27T10:00:00Z"),
    );
    expect(file.fileName).toBe("opensesame-store-manifest-2026-09-27.json");
    expect(file.count).toBe(1);
    expect(file.text.endsWith("\n")).toBe(true);
    expect(JSON.parse(file.text)).toEqual([
      {
        path: "Token",
        secret: "t0k3n",
        trailer: '{"kind":"secret","v":2}\n',
      },
    ]);
  });
});
