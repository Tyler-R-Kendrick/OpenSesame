import { describe, expect, it } from "vitest";
import { createItem, newUri } from "./model.js";
import {
  entriesToVaultItems,
  entryToVaultItem,
  extractOtpauthFromTrailer,
  filterEntriesForProject,
  joinStorePath,
  mergeOtpauthIntoTrailer,
  parseTrailerMeta,
  sealedBytesToSyncBlobs,
  splitStorePath,
  stripOtpauthFromTrailer,
  vaultItemToEntry,
} from "./store-sync.js";

describe("otpauth trailer lines", () => {
  const URI = "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP";

  it("finds the first otpauth line, case-insensitively, anywhere in the trailer", () => {
    expect(extractOtpauthFromTrailer(`notes\n  ${URI}\nmore`)).toBe(URI);
    expect(
      extractOtpauthFromTrailer("OTPAUTH://totp/x?secret=ABC"),
    ).toBeTruthy();
    expect(extractOtpauthFromTrailer("no otp here")).toBeNull();
  });

  it("strips otpauth lines but keeps everything else", () => {
    expect(stripOtpauthFromTrailer(`a\n${URI}\nb`)).toBe("a\nb");
  });

  it("merges exactly one otpauth line into a trailer", () => {
    expect(mergeOtpauthIntoTrailer("", null)).toBe("");
    expect(mergeOtpauthIntoTrailer("notes\n", null)).toBe("notes\n");
    expect(mergeOtpauthIntoTrailer("", URI)).toBe(`${URI}\n`);
    expect(mergeOtpauthIntoTrailer("notes\n\n", URI)).toBe(`notes\n${URI}\n`);
    // An existing otpauth line is replaced, not duplicated.
    expect(mergeOtpauthIntoTrailer(`${URI}\n`, URI)).toBe(`${URI}\n`);
  });
});

describe("store path splitting", () => {
  it("treats a bare name as folderless", () => {
    expect(splitStorePath("github")).toEqual({
      folder: null,
      name: "github",
    });
  });

  it("keeps nested folders whole and tolerates stray slashes", () => {
    expect(splitStorePath("/Email/work/github/")).toEqual({
      folder: "Email/work",
      name: "github",
    });
    expect(splitStorePath("///")).toEqual({ folder: null, name: "untitled" });
    expect(splitStorePath("/name")).toEqual({ folder: null, name: "name" });
  });

  it("joins the way it splits", () => {
    expect(joinStorePath(null, "")).toBe("untitled");
    expect(joinStorePath(" Email ", "x")).toBe("Email/x");
  });
});

describe("parseTrailerMeta", () => {
  it("parses JSON trailers and treats the rest as notes", () => {
    expect(parseTrailerMeta('{"kind":"note"}')).toEqual({ kind: "note" });
    expect(parseTrailerMeta("just some words")).toEqual({
      notes: "just some words",
    });
    expect(parseTrailerMeta("{not json")).toEqual({ notes: "{not json" });
    expect(parseTrailerMeta("")).toEqual({ notes: undefined });
  });
});

describe("entryToVaultItem kinds", () => {
  it("builds a note from kind metadata, folding the secret into the body", () => {
    const item = entryToVaultItem({
      path: "docs/recovery",
      secret: "seed words here",
      trailer: '{"kind":"note","notes":"keep offline"}',
    });
    expect(item.kind).toBe("note");
    expect(item.name).toBe("recovery");
    expect(item.notes).toBe("seed words here\nkeep offline");
  });

  it("builds a secret with its connection ref", () => {
    const item = entryToVaultItem({
      path: "agents/deploy",
      secret: "whsec_123",
      trailer: '{"kind":"secret","connectionRef":"conn_1","notes":"rotated"}',
    });
    if (item.kind !== "secret") throw new Error("expected secret");
    expect(item.value).toBe("whsec_123");
    expect(item.connectionRef).toBe("conn_1");
    expect(item.notes).toBe("rotated");
  });

  it("prefers an otpauth trailer line over a bare seed in metadata", () => {
    const otp = "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP";
    const item = entryToVaultItem({
      path: "mail",
      secret: "pw",
      trailer: `{"username":"ada"}\n${otp}`,
    });
    if (item.kind !== "login") throw new Error("expected login");
    expect(item.totp).toBe(otp);
    expect(item.username).toBe("ada");
  });
});

describe("vaultItemToEntry kinds", () => {
  it("maps a card with its holder line into notes", () => {
    const card = createItem("card", "Visa");
    if (card.kind !== "card") throw new Error("expected card");
    card.number = "4111111111111111";
    card.cardholder = "A. Rowan";
    card.notes = "expires soon";
    const entry = vaultItemToEntry(card, []);
    expect(entry.secret).toBe("4111111111111111");
    expect(entry.trailer).toContain("A. Rowan\\nexpires soon");

    const bare = createItem("card", "Bare");
    const bareEntry = vaultItemToEntry(bare, []);
    expect(bareEntry.trailer).not.toContain("\\n");
  });

  it("maps a passkey by credential id", () => {
    const passkey = createItem("passkey", "Key");
    if (passkey.kind !== "passkey") throw new Error("expected passkey");
    passkey.credentialIdB64 = "Y3JlZA==";
    const entry = vaultItemToEntry(passkey, []);
    expect(entry.secret).toBe("Y3JlZA==");
  });

  it("maps a note body into the secret slot", () => {
    const note = createItem("note", "Words");
    note.notes = "the body";
    const entry = vaultItemToEntry(note, []);
    expect(entry.secret).toBe("the body");
    // The body moved into the secret slot; the trailer must not repeat it.
    expect(entry.trailer).not.toContain("the body");
  });

  it("writes a bare TOTP seed as metadata and an otpauth URI as a line", () => {
    const seedLogin = createItem("login", "Seed");
    if (seedLogin.kind !== "login") throw new Error("expected login");
    seedLogin.totp = "JBSWY3DPEHPK3PXP";
    expect(vaultItemToEntry(seedLogin, []).trailer).toContain(
      '"totp":"JBSWY3DPEHPK3PXP"',
    );

    const uriLogin = createItem("login", "Uri");
    if (uriLogin.kind !== "login") throw new Error("expected login");
    uriLogin.totp = "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP";
    const entry = vaultItemToEntry(uriLogin, []);
    expect(entry.trailer).toContain("otpauth://totp/x");
  });

  it("drops empty URI slots from login metadata", () => {
    const login = createItem("login", "Uris");
    if (login.kind !== "login") throw new Error("expected login");
    login.uris = [newUri("https://a.example"), newUri("")];
    const entry = vaultItemToEntry(login, []);
    expect(entry.trailer).toContain('"uris":["https://a.example"]');
  });
});

describe("entriesToVaultItems", () => {
  it("reuses existing folders case-insensitively and creates the rest once", () => {
    const existing = [
      { id: "f1", name: "Email", createdAt: new Date().toISOString() },
    ];
    const { items, folders } = entriesToVaultItems(
      [
        { path: "email/a", secret: "x", trailer: "" },
        { path: "Email/b", secret: "y", trailer: "" },
        { path: "Banking/c", secret: "z", trailer: "" },
        { path: "loose", secret: "w", trailer: "" },
      ],
      existing,
    );
    expect(folders).toHaveLength(2);
    expect(items[0]?.folderId).toBe("f1");
    expect(items[1]?.folderId).toBe("f1");
    const banking = folders.find((f) => f.name === "Banking");
    expect(items[2]?.folderId).toBe(banking?.id);
    expect(items[3]?.folderId).toBeNull();
  });
});

describe("filterEntriesForProject", () => {
  const entries = [
    { path: "proj/a", secret: "", trailer: "" },
    { path: "proj", secret: "", trailer: "" },
    { path: "other/b", secret: "", trailer: "" },
  ];

  it("keeps only entries under the project folder", () => {
    expect(filterEntriesForProject(entries, "proj").map((e) => e.path)).toEqual(
      ["proj/a", "proj"],
    );
    expect(
      filterEntriesForProject(entries, "proj/").map((e) => e.path),
    ).toEqual(["proj/a", "proj"]);
  });

  it("passes everything through without a project folder", () => {
    expect(filterEntriesForProject(entries, null)).toHaveLength(3);
    expect(filterEntriesForProject(entries, "  ")).toHaveLength(3);
  });
});

describe("sync blob ids", () => {
  it("refuses to ship an empty ciphertext blob", () => {
    expect(() =>
      sealedBytesToSyncBlobs([
        { id: "x", epoch: 1, ciphertext: new Uint8Array() },
      ]),
    ).toThrow(/empty ciphertext/);
    const blobs = sealedBytesToSyncBlobs([
      { id: "x", epoch: 2, ciphertext: new Uint8Array([104, 105]) },
    ]);
    expect(atob(blobs[0]?.ciphertextB64 ?? "")).toBe("hi");
  });
});
