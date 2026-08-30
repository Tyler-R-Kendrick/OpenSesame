import type {
  BoundaryValue,
  JsonObject,
  JsonValue,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";

import type { DetectInput, ParseInput, ParseResult } from "../types.js";
import { fidoCxf } from "./cxf.js";

/**
 * The importer read against documents written by *other* managers, which is
 * where it actually has to hold up. `export/cxf.test.ts` covers the round trip
 * through this vault's own writer.
 */

function document(
  items: JsonValue[],
  collections: JsonValue[] = [],
): JsonObject {
  return {
    version: 1,
    exporter: "SomeOtherManager",
    timestamp: 1_772_600_767,
    accounts: [
      {
        id: "acct",
        username: "ada",
        email: "ada@example.com",
        collections,
        items,
      },
    ],
  };
}

function input(json: BoundaryValue): ParseInput {
  return {
    fileName: "export.json",
    text: JSON.stringify(json),
    headers: null,
    json,
    bytes: null,
  };
}

function parse(json: BoundaryValue): ParseResult {
  return fidoCxf.parse(input(json));
}

const BASIC = {
  id: "i1",
  creationAt: 1_767_324_245,
  modifiedAt: 1_770_090_306,
  title: "Example",
  scope: { urls: ["https://example.com"], androidApps: [] },
  credentials: [
    {
      type: "basic-auth",
      username: { fieldType: "email", value: "ada@example.com" },
      password: { fieldType: "concealed-string", value: "hunter2" },
    },
  ],
};

describe("fidoCxf.detect", () => {
  const base: Omit<DetectInput, "json"> = {
    fileName: "export.json",
    text: "",
    headers: null,
    bytes: null,
  };

  it("claims a document with a version, an exporter, and accounts", () => {
    expect(fidoCxf.detect({ ...base, json: document([]) })).toBe(true);
  });

  it("declines other JSON without throwing", () => {
    for (const json of [
      null,
      [],
      {},
      { accounts: [] },
      { version: 1, exporter: "x" },
      { version: 1, exporter: "x", accounts: "not an array" },
      // A Bitwarden export, which also has a top-level array of things.
      { encrypted: false, items: [] },
    ]) {
      expect(fidoCxf.detect({ ...base, json })).toBe(false);
    }
  });

  it("declines a CSV that happens to be in hand", () => {
    expect(
      fidoCxf.detect({
        ...base,
        text: "name,password",
        headers: ["name", "password"],
        json: null,
      }),
    ).toBe(false);
  });
});

describe("fidoCxf.parse of a foreign document", () => {
  it("maps a basic-auth item to a login with its URLs", () => {
    const result = parse(document([BASIC]));
    const item = result.items[0];
    if (item?.kind !== "login") throw new Error("expected a login");
    expect(item.username).toBe("ada@example.com");
    expect(item.password).toBe("hunter2");
    expect(item.uris.map((uri) => uri.uri)).toEqual(["https://example.com"]);
    expect(item.createdAt).toBe("2026-01-02T03:24:05.000Z");
    expect(item.updatedAt).toBe("2026-02-03T03:45:06.000Z");
  });

  it("folds a totp credential into the login beside it", () => {
    const result = parse(
      document([
        {
          ...BASIC,
          credentials: [
            ...BASIC.credentials,
            {
              type: "totp",
              secret: "JBSWY3DPEHPK3PXP",
              period: 30,
              digits: 6,
              algorithm: "sha1",
              username: "ada",
            },
          ],
        },
      ]),
    );
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    if (item?.kind !== "login") throw new Error("expected a login");
    // Defaults throughout, so the bare seed says everything the URI would.
    expect(item.totp).toBe("JBSWY3DPEHPK3PXP");
  });

  it("builds an otpauth URI when the parameters are not the defaults", () => {
    const result = parse(
      document([
        {
          id: "t",
          title: "Bank",
          credentials: [
            {
              type: "totp",
              secret: "JBSWY3DPEHPK3PXP",
              period: 60,
              digits: 8,
              algorithm: "sha512",
              username: "ada",
              issuer: "Bank plc",
            },
          ],
        },
      ]),
    );
    const item = result.items[0];
    if (item?.kind !== "login") throw new Error("expected a login");
    expect(item.totp).toBe(
      "otpauth://totp/Bank%3Aada?secret=JBSWY3DPEHPK3PXP&issuer=Bank+plc&period=60&digits=8&algorithm=SHA512",
    );
  });

  it("accepts the specification's CamelCase spelling of a type", () => {
    const result = parse(
      document([
        {
          id: "c",
          title: "Camel",
          credentials: [
            {
              type: "BasicAuth",
              username: { fieldType: "string", value: "ada" },
              password: { fieldType: "concealed-string", value: "pw" },
            },
          ],
        },
      ]),
    );
    expect(result.items[0]?.kind).toBe("login");
  });

  it("takes a bare string where an exporter skipped the EditableField", () => {
    const result = parse(
      document([
        {
          id: "b",
          title: "Bare",
          credentials: [
            { type: "basic-auth", username: "ada", password: "hunter2" },
          ],
        },
      ]),
    );
    const item = result.items[0];
    if (item?.kind !== "login") throw new Error("expected a login");
    expect(item.username).toBe("ada");
    expect(item.password).toBe("hunter2");
  });

  it("imports a foreign passkey without its private key, and says so", () => {
    const result = parse(
      document([
        {
          id: "p",
          title: "example.org",
          credentials: [
            {
              type: "passkey",
              credentialId: "Y3JlZC1pZC0wMDE",
              rpId: "example.org",
              username: "ada@example.org",
              userDisplayName: "Ada",
              userHandle: "dXNlcg",
              key: "TUlHSEFnRUFNQk1HQnlxR1NNNDlB", // gitleaks:allow -- truncated PEM header, no key body
            },
          ],
        },
      ]),
    );
    const item = result.items[0];
    if (item?.kind !== "passkey") throw new Error("expected a passkey");
    expect(item.rpId).toBe("example.org");
    expect(item.credentialIdB64).toBe("Y3JlZC1pZC0wMDE=");
    expect(item.publicKeyB64).toBe("");
    expect(JSON.stringify(item)).not.toContain("TUlHSEFnRUFNQk1HQnlxR1NNNDlB");
    expect(result.warnings.join(" ")).toMatch(/never holds one/u);
  });

  it("falls back to the display name when a passkey has no username", () => {
    const result = parse(
      document([
        {
          id: "p",
          title: "example.org",
          credentials: [
            {
              type: "passkey",
              credentialId: "aWQ",
              rpId: "example.org",
              username: "",
              userDisplayName: "Ada Lovelace",
            },
          ],
        },
      ]),
    );
    const item = result.items[0];
    if (item?.kind !== "passkey") throw new Error("expected a passkey");
    expect(item.username).toBe("Ada Lovelace");
  });

  it("maps an SSH key and an API key onto secrets", () => {
    const result = parse(
      document([
        {
          id: "s",
          title: "Build box",
          credentials: [
            {
              type: "ssh-key",
              keyType: "ed25519",
              privateKey: {
                fieldType: "concealed-string",
                value: "-----BEGIN OPENSSH PRIVATE KEY-----", // gitleaks:allow -- header line only, no key body
              },
              keyComment: "ada@laptop",
            },
          ],
        },
        {
          id: "a",
          title: "Weather service",
          credentials: [
            {
              type: "APIKey",
              key: { fieldType: "concealed-string", value: "wk-123" },
              username: "ada",
            },
          ],
        },
      ]),
    );
    const [ssh, api] = result.items;
    if (ssh?.kind !== "secret" || api?.kind !== "secret") {
      throw new Error("expected two secrets");
    }
    expect(ssh.value).toBe("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(ssh.fields).toEqual([
      { name: "Key type", value: "ed25519", hidden: false },
      { name: "Comment", value: "ada@laptop", hidden: false },
    ]);
    expect(api.value).toBe("wk-123");
    expect(api.fields).toEqual([
      { name: "Username", value: "ada", hidden: false },
    ]);
  });

  it("accepts both the legacy and the current secret keyType", () => {
    // Older exports wrote `opensesame-agent-secret`; the rename to
    // `opensesame-secret` must not strand those files (ADR 0061).
    const apiKey = (keyType: string) => ({
      id: keyType,
      title: keyType,
      credentials: [
        {
          type: "api-key",
          key: { fieldType: "concealed-string", value: "wk-1" },
          keyType,
          extensions: [
            { name: "com.opensesame.vault", connectionRef: "conn:x:y" },
          ],
        },
      ],
    });
    const result = parse(
      document([
        apiKey("opensesame-agent-secret"),
        apiKey("opensesame-secret"),
      ]),
    );
    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      if (item.kind !== "secret") throw new Error("expected secrets");
      expect(item.value).toBe("wk-1");
      expect(item.fields).toEqual([
        { name: "Connection", value: "conn:x:y", hidden: false },
      ]);
    }
  });

  it("keeps a URL on a non-login item as a field rather than losing it", () => {
    const result = parse(
      document([
        {
          id: "n",
          title: "Recipe",
          scope: { urls: ["https://example.com/recipe"], androidApps: [] },
          credentials: [
            { type: "note", content: { fieldType: "string", value: "Stir." } },
          ],
        },
      ]),
    );
    const item = result.items[0];
    if (item?.kind !== "note") throw new Error("expected a note");
    expect(item.fields).toEqual([
      { name: "Website", value: "https://example.com/recipe", hidden: false },
    ]);
  });

  it("skips a credential kind this vault has no home for, with a reason", () => {
    const result = parse(
      document([
        {
          id: "w",
          title: "Home Wi-Fi",
          credentials: [{ type: "wifi", ssid: "Home", passphrase: "hunter2" }],
        },
        {
          id: "addr",
          title: "Home address",
          credentials: [{ type: "address", streetAddress: "1 Example Way" }],
        },
      ]),
    );
    expect(result.items).toEqual([]);
    expect(result.skipped).toEqual([
      { name: "Home Wi-Fi", reason: expect.stringContaining("Wi-Fi network") },
      { name: "Home address", reason: expect.stringContaining("address") },
    ]);
  });

  it("imports what it can from an item that also carries something it cannot", () => {
    const result = parse(
      document([
        {
          ...BASIC,
          credentials: [...BASIC.credentials, { type: "wifi", ssid: "Home" }],
        },
      ]),
    );
    expect(result.items).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/rest of the item was imported/u);
  });

  it("reads folder membership out of collections, nesting included", () => {
    const result = parse(
      document(
        [
          { ...BASIC, id: "top" },
          { ...BASIC, id: "deep", title: "Deep" },
          { ...BASIC, id: "loose", title: "Loose" },
        ],
        [
          {
            id: "c1",
            title: "Work",
            items: [{ item: "top" }],
            subcollections: [{ id: "c2", title: "Vendors", items: ["deep"] }],
          },
        ],
      ),
    );
    expect(result.items.map((item) => item.folder)).toEqual([
      "Work",
      "Work/Vendors",
      null,
    ]);
  });
});

describe("fidoCxf.parse of a malformed document", () => {
  it("returns nothing rather than throwing when handed the wrong JSON", () => {
    for (const json of [null, [], {}, { accounts: 3 }]) {
      expect(parse(json)).toEqual({
        source: "fido-cxf",
        items: [],
        skipped: [],
        warnings: [],
      });
    }
  });

  it("steps over an account, an item, and a credential that are not objects", () => {
    const result = parse({
      version: 1,
      exporter: "x",
      accounts: [null, 7, "nope", { items: [null, 3, BASIC, []] }],
    });
    expect(result.items).toHaveLength(1);
  });

  it("names an item whose title is missing or blank", () => {
    const result = parse(
      document([
        { id: "x", credentials: BASIC.credentials },
        { id: "y", title: "   ", credentials: BASIC.credentials },
      ]),
    );
    expect(result.items.map((item) => item.name)).toEqual([
      "Untitled",
      "Untitled",
    ]);
  });

  it("ignores a timestamp that is not a positive number", () => {
    const result = parse(
      document([
        {
          ...BASIC,
          creationAt: "yesterday",
          modifiedAt: -1,
        },
      ]),
    );
    expect(result.items[0]?.createdAt).toBeNull();
    expect(result.items[0]?.updatedAt).toBeNull();
  });

  it("ignores a collection link that names no item", () => {
    const result = parse(
      document([BASIC], [{ id: "c", title: "Work", items: [{}, "", 5] }]),
    );
    expect(result.items[0]?.folder).toBeNull();
  });
});
