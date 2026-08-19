import { describe, expect, it } from "vitest";
import {
  KIND_LABEL,
  KIND_PLURAL,
  browsableUrl,
  createItem,
  emptyBody,
  hostOf,
  initialOf,
  itemSubtitle,
  newGrant,
  newId,
  newUri,
  searchMatches,
  sortItems,
} from "./model.js";

describe("createItem", () => {
  it("builds each kind with its own shape over a common base", () => {
    const login = createItem("login", "Site");
    expect(login.kind).toBe("login");
    if (login.kind === "login") {
      expect(login.username).toBe("");
      expect(login.passwordChangedAt).toBe(login.createdAt);
    }

    const passkey = createItem("passkey");
    if (passkey.kind !== "passkey") throw new Error("expected passkey");
    expect(passkey.authenticator).toBe("platform");
    expect(passkey.unlocksVault).toBe(false);

    const card = createItem("card");
    if (card.kind !== "card") throw new Error("expected card");
    expect(card.number).toBe("");

    const secret = createItem("secret");
    if (secret.kind !== "secret") throw new Error("expected secret");
    expect(secret.ceiling).toEqual([]);
    expect(secret.grantees).toEqual([]);

    const note = createItem("note");
    expect(note.kind).toBe("note");

    for (const item of [login, passkey, card, secret, note]) {
      expect(item.id).toBeTruthy();
      expect(item.deletedAt).toBeNull();
      expect(item.favorite).toBe(false);
      expect(item.fields).toEqual([]);
    }
  });
});

describe("id and body helpers", () => {
  it("mints unique ids", () => {
    expect(newId()).not.toBe(newId());
  });

  it("starts an empty body at revision zero", () => {
    expect(emptyBody()).toEqual({ v: 1, items: [], folders: [], rev: 0 });
  });

  it("defaults new URIs and grants to editable blanks", () => {
    const uri = newUri();
    expect(uri).toMatchObject({ uri: "", match: "domain" });
    expect(newUri("https://a.example", "exact")).toMatchObject({
      uri: "https://a.example",
      match: "exact",
    });
    const grant = newGrant();
    expect(grant).toMatchObject({ action: "", resource: "" });
    expect(newGrant("http.post", "https://h.example").action).toBe("http.post");
  });
});

describe("itemSubtitle", () => {
  it("shows the username for logins, then the first host, then a fallback", () => {
    const login = createItem("login");
    if (login.kind !== "login") throw new Error("expected login");
    expect(itemSubtitle(login)).toBe("No username");
    login.uris = [newUri("https://mail.example.com/inbox")];
    expect(itemSubtitle(login)).toBe("mail.example.com");
    login.username = "ada";
    expect(itemSubtitle(login)).toBe("ada");
  });

  it("pairs passkey username with the relying party", () => {
    const passkey = createItem("passkey");
    if (passkey.kind !== "passkey") throw new Error("expected passkey");
    passkey.rpId = "example.com";
    expect(itemSubtitle(passkey)).toBe("example.com");
    passkey.username = "ada@example.com";
    expect(itemSubtitle(passkey)).toBe("ada@example.com · example.com");
  });

  it("masks a card number and falls back to the brand", () => {
    const card = createItem("card");
    if (card.kind !== "card") throw new Error("expected card");
    card.brand = "Visa";
    expect(itemSubtitle(card)).toBe("Visa");
    card.number = "4111111111111111";
    expect(itemSubtitle(card)).toBe("•••• 1111");
  });

  it("shows a secret's connection ref, else its capability count", () => {
    const secret = createItem("secret");
    if (secret.kind !== "secret") throw new Error("expected secret");
    expect(itemSubtitle(secret)).toBe("0 capabilities");
    secret.ceiling = [newGrant("http.get", "https://h.example")];
    expect(itemSubtitle(secret)).toBe("1 capabilities");
    secret.connectionRef = "conn_1";
    expect(itemSubtitle(secret)).toBe("conn_1");
  });

  it("summarises a note by first line, field count, or Empty note", () => {
    const note = createItem("note");
    expect(itemSubtitle(note)).toBe("Empty note");
    note.fields = [
      { id: newId(), name: "a", value: "b", hidden: false },
      { id: newId(), name: "c", value: "d", hidden: true },
    ];
    expect(itemSubtitle(note)).toBe("2 fields");
    note.fields = [{ id: newId(), name: "a", value: "b", hidden: false }];
    expect(itemSubtitle(note)).toBe("1 field");
    note.notes = "first line\nsecond line";
    expect(itemSubtitle(note)).toBe("first line");
  });
});

describe("hostOf", () => {
  it("returns the host for full and bare URIs", () => {
    expect(hostOf("https://example.com/path")).toBe("example.com");
    expect(hostOf("example.com/path")).toBe("example.com");
  });

  it("returns empty for missing or unparseable URIs", () => {
    expect(hostOf(undefined)).toBe("");
    expect(hostOf("")).toBe("");
    expect(hostOf("http://exam ple")).toBe("");
  });
});

describe("browsableUrl", () => {
  it("only links http(s), never script or data schemes", () => {
    expect(browsableUrl("https://example.com")).toBe("https://example.com/");
    expect(browsableUrl("example.com")).toBe("https://example.com/");
    expect(browsableUrl("http://localhost:5180")).toBe(
      "http://localhost:5180/",
    );
    expect(browsableUrl("javascript:alert(1)")).toBeNull();
    expect(browsableUrl("data:text/html,<b>hi</b>")).toBeNull();
    expect(browsableUrl(undefined)).toBeNull();
    expect(browsableUrl("http://exam ple")).toBeNull();
  });
});

describe("initialOf", () => {
  it("uses the first letter of the name, uppercased", () => {
    const item = createItem("note", "  recovery kit");
    expect(initialOf(item)).toBe("R");
  });

  it("falls back to the subtitle, then to a placeholder", () => {
    const login = createItem("login", "");
    if (login.kind !== "login") throw new Error("expected login");
    login.username = "ada";
    expect(initialOf(login)).toBe("A");

    const blank = createItem("note", "");
    expect(initialOf(blank)).toBe("E"); // "Empty note" subtitle
  });
});

describe("searchMatches", () => {
  it("matches everything on a blank query", () => {
    expect(searchMatches(createItem("note", "x"), "   ")).toBe(true);
  });

  it("searches kind labels and notes for every item", () => {
    const note = createItem("note", "boring title");
    note.notes = "the spare house key";
    expect(searchMatches(note, "secure note")).toBe(true);
    expect(searchMatches(note, "HOUSE KEY")).toBe(true);
    expect(searchMatches(note, "unrelated")).toBe(false);
  });

  it("searches login usernames and URIs", () => {
    const login = createItem("login", "Mail");
    if (login.kind !== "login") throw new Error("expected login");
    login.username = "ada@example.com";
    login.uris = [newUri("https://mail.example.com")];
    expect(searchMatches(login, "ada@")).toBe(true);
    expect(searchMatches(login, "mail.example")).toBe(true);
    expect(searchMatches(login, "bank")).toBe(false);
  });

  it("searches passkey relying party and card brand/holder", () => {
    const passkey = createItem("passkey", "Key");
    if (passkey.kind !== "passkey") throw new Error("expected passkey");
    passkey.rpId = "accounts.example.com";
    expect(searchMatches(passkey, "accounts.example")).toBe(true);

    const card = createItem("card", "Card");
    if (card.kind !== "card") throw new Error("expected card");
    card.cardholder = "A. Rowan";
    expect(searchMatches(card, "rowan")).toBe(true);
  });

  it("searches secret connection refs and grantees", () => {
    const secret = createItem("secret", "Deploy");
    if (secret.kind !== "secret") throw new Error("expected secret");
    secret.connectionRef = "conn_deploy";
    secret.grantees = ["agt_release_bot"];
    expect(searchMatches(secret, "conn_dep")).toBe(true);
    expect(searchMatches(secret, "release_bot")).toBe(true);
  });

  it("never searches the value of a hidden field", () => {
    const item = createItem("note", "Identity");
    item.fields = [
      { id: newId(), name: "SSN", value: "s3cr3t-value", hidden: true },
    ];
    expect(searchMatches(item, "ssn")).toBe(true);
    expect(searchMatches(item, "s3cr3t-value")).toBe(false);
  });
});

describe("sortItems", () => {
  it("floats favorites, then orders by name case-insensitively", () => {
    const a = createItem("note", "alpha");
    const b = createItem("note", "Beta");
    const c = createItem("note", "gamma");
    b.favorite = true;
    const sorted = sortItems([c, b, a]);
    expect(sorted.map((item) => item.name)).toEqual(["Beta", "alpha", "gamma"]);
    // The input array is left alone.
    expect([c, b, a][0]?.name).toBe("gamma");
  });
});

describe("kind labels", () => {
  it("has a singular and plural label for every kind", () => {
    for (const kind of [
      "login",
      "passkey",
      "card",
      "secret",
      "note",
    ] as const) {
      expect(KIND_LABEL[kind]).toBeTruthy();
      expect(KIND_PLURAL[kind]).toBeTruthy();
    }
    expect(KIND_PLURAL.secret).toBe("Agent secrets");
  });
});
