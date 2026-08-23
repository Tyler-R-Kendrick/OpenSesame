import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  overlapCast,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { bitwardenCsv, bitwardenJson } from "./formats/bitwarden.js";
import { chromiumCsv, firefoxCsv, genericCsv } from "./formats/browsers.js";
import { envFile, parseDotenv } from "./formats/env.js";
import {
  dashlaneCsv,
  keepassCsv,
  keepassxcCsv,
  lastpassCsv,
  nordpassCsv,
} from "./formats/managers.js";
import { onepasswordCsv, onepasswordPux } from "./formats/onepassword.js";
import { protonpassJson } from "./formats/protonpass.js";
import type { DetectInput } from "./types.js";

function csvInput(text: string, headers: string[] | null): DetectInput {
  return { fileName: "export.csv", text, headers, bytes: null, json: null };
}

describe("parseDotenv quoting and escapes", () => {
  it("unescapes double-quoted values", () => {
    const [pair] = parseDotenv('KEY="line1\\nline2\\t\\"q\\"\\\\"');
    expect(pair?.value).toBe('line1\nline2\t"q"\\');
  });

  it("keeps hashes inside quotes, strips them outside", () => {
    expect(parseDotenv("A='va # lue'")[0]?.value).toBe("va # lue");
    expect(parseDotenv('B="va # lue"')[0]?.value).toBe("va # lue");
    expect(parseDotenv("C=value # comment")[0]?.value).toBe("value");
    expect(parseDotenv("D=value#notcomment")[0]?.value).toBe("value");
  });

  it("joins a multiline quoted value", () => {
    const pairs = parseDotenv('MULTI="first\nsecond\nthird"\nAFTER=done');
    expect(pairs[0]).toEqual({ key: "MULTI", value: "first\nsecond\nthird" });
    expect(pairs[1]).toEqual({ key: "AFTER", value: "done" });
  });

  it("takes an unterminated quote as the rest of the file", () => {
    const pairs = parseDotenv("OPEN='never closed\nstill going");
    expect(pairs[0]?.key).toBe("OPEN");
    expect(pairs[0]?.value).toContain("still going");
  });

  it("strips a trailing comment after a quoted value", () => {
    const [pair] = parseDotenv('Q="a\\"b" # done');
    expect(pair?.value).toBe('"a\\"b"');
  });

  it("unescapes single-quoted values", () => {
    expect(parseDotenv("S='it\\'s'")[0]?.value).toBe("it's");
  });
});

describe("envFile detection", () => {
  it("ignores structured input entirely", () => {
    expect(
      envFile.detect({
        fileName: ".env",
        text: "KEY=value",
        headers: null,
        bytes: null, json: { some: "json" },
      }),
    ).toBe(false);
    expect(
      envFile.detect({
        fileName: ".env",
        text: "a,b\nKEY=value",
        headers: ["a", "b"],
        bytes: null,
        json: null,
      }),
    ).toBe(false);
  });

  it("trusts a dotenv filename with parseable content", () => {
    for (const name of [".env", ".env.local", "prod.env", ".env.example"]) {
      expect(
        envFile.detect({
          fileName: name,
          text: "KEY=value\n# comment\nnot a pair",
          headers: null,
          bytes: null,
          json: null,
        }),
      ).toBe(true);
    }
  });

  it("needs a strong ratio when the name does not say dotenv", () => {
    const strong = {
      fileName: "settings.txt",
      text: "A=1\nB=2\nC=3",
      headers: null,
      bytes: null,
      json: null,
    };
    expect(envFile.detect(strong)).toBe(true);
    const weak = { ...strong, text: "A=1\nB=2\njust words\nmore words" };
    expect(envFile.detect(weak)).toBe(false);
  });

  it("skips duplicate keys and empty values with reasons", () => {
    const result = envFile.parse({
      fileName: ".env",
      text: "A=1\nA=2\nEMPTY=",
      headers: null,
      bytes: null,
      json: null,
    });
    expect(result.items).toHaveLength(1);
    expect(result.skipped.map((s) => s.name)).toEqual(["A", "EMPTY"]);
    expect(result.skipped[0]?.reason).toMatch(/Duplicate key/);
    expect(result.skipped[1]?.reason).toMatch(/Empty value/);
  });

  it("warns only when something was imported", () => {
    const nothing = envFile.parse({
      fileName: ".env",
      text: "EMPTY=",
      headers: null,
      bytes: null,
      json: null,
    });
    expect(nothing.warnings).toEqual([]);
  });
});

describe("LastPass extras", () => {
  it("leaves folderless rows folderless and untyped notes as plain notes", () => {
    const text = [
      "url,username,password,name,grouping,extra",
      "https://sn,,,Secure note,,just a sentence",
      "https://site.example,u,p,Site,,",
    ].join("\n");
    const result = lastpassCsv.parse(csvInput(text, []));
    expect(result.items[0]?.kind).toBe("note");
    expect(result.items[0]?.notes).toBe("just a sentence");
    expect(result.items[0]?.folder).toBeNull();
    expect(result.items[1]?.folder).toBeNull();
  });

  it("ignores colon-less lines inside a typed secure note", () => {
    const text = [
      "url,username,password,name,grouping,extra",
      'http://sn,,,Bank,Finance,"NoteType:Bank\nno colon here\nRouting:123"',
    ].join("\n");
    const result = lastpassCsv.parse(csvInput(text, []));
    const note = result.items[0];
    // NoteType is kept as a field; the colon-less line is ignored.
    expect(note?.fields.map((f) => f.name)).toEqual(["NoteType", "Routing"]);
  });

  it("names a row after its host when no name is given", () => {
    const text = [
      "url,username,password,name",
      "https://mail.example.com,u,p,",
    ].join("\n");
    const result = lastpassCsv.parse(csvInput(text, []));
    expect(result.items[0]?.name).toBe("mail.example.com");
  });
});

describe("KeePass extras", () => {
  it("keeps a KeePassXC group that has no Root prefix", () => {
    const text = ["group,title,username,password", "Email,Gmail,u,p"].join(
      "\n",
    );
    const result = keepassxcCsv.parse(csvInput(text, []));
    expect(result.items[0]?.folder).toBe("Email");
  });

  it("falls back to the host, then Untitled, for KeePass 2.x rows", () => {
    const text = [
      "account,login name,password,web site",
      ",u,p,https://shop.example",
      ",u,p,",
    ].join("\n");
    const result = keepassCsv.parse(csvInput(text, []));
    expect(result.items[0]?.name).toBe("shop.example");
    expect(result.items[1]?.name).toBe("Untitled");
  });
});

describe("Dashlane extras", () => {
  it("reads the two-column secure notes file", () => {
    const text = "title,note\nWifi,the password is on the fridge";
    const result = dashlaneCsv.parse(csvInput(text, ["title", "note"]));
    expect(result.items[0]?.kind).toBe("note");
    expect(result.items[0]?.notes).toBe("the password is on the fridge");
    expect(result.warnings).toEqual([]);
  });

  it("detects nothing without headers", () => {
    expect(dashlaneCsv.detect(csvInput("", null))).toBe(false);
  });

  it("names an untitled credential after its host", () => {
    const text = [
      "title,password,url,username",
      ",p,https://bank.example,u",
    ].join("\n");
    const result = dashlaneCsv.parse(csvInput(text, []));
    expect(result.items[0]?.name).toBe("bank.example");
  });
});

describe("NordPass extras", () => {
  it("keeps a row with no credential at all as a note with address fields", () => {
    const text = [
      "name,folder,full_name,city,note",
      "Home address,Personal,Ada Rowan,Springfield,ring the bell",
    ].join("\n");
    const result = nordpassCsv.parse(csvInput(text, []));
    const item = result.items[0];
    expect(item?.kind).toBe("note");
    expect(item?.folder).toBe("Personal");
    expect(item?.fields).toEqual(
      expect.arrayContaining([
        { name: "full name", value: "Ada Rowan", hidden: false },
        { name: "city", value: "Springfield", hidden: false },
      ]),
    );
  });

  it("ignores an expiry that is not MM/YYYY", () => {
    const text = [
      "name,cardnumber,expirydate",
      "Travel card,4111111111111111,next year",
    ].join("\n");
    const result = nordpassCsv.parse(csvInput(text, []));
    if (result.items[0]?.kind !== "card") throw new Error("expected card");
    expect(result.items[0].expMonth).toBe("");
  });

  it("splits a MM/YYYY expiry", () => {
    const text = [
      "name,cardnumber,expirydate",
      "Travel card,4111111111111111,04/2029",
    ].join("\n");
    const result = nordpassCsv.parse(csvInput(text, []));
    if (result.items[0]?.kind !== "card") throw new Error("expected card");
    expect(result.items[0].expMonth).toBe("04");
    expect(result.items[0].expYear).toBe("2029");
  });
});

describe("browser CSV extras", () => {
  it("names a Chromium row after its host, then Untitled", () => {
    const text = "name,url,username,password\n,https://x.example,u,p\n,,u,p";
    const result = chromiumCsv.parse(csvInput(text, []));
    expect(result.items[0]?.name).toBe("x.example");
    expect(result.items[1]?.name).toBe("Untitled");
  });

  it("reads Firefox timestamps only when they are numbers", () => {
    const text = [
      "url,username,password,guid,timecreated,timepasswordchanged",
      "https://x.example,u,p,g,1700000000,not-a-number",
    ].join("\n");
    const result = firefoxCsv.parse(csvInput(text, []));
    expect(result.items[0]?.createdAt).toBe("2023-11-14T22:13:20.000Z");
    expect(result.items[0]?.passwordChangedAt).toBeNull();
  });

  it("generic detection refuses headerless or passwordless input", () => {
    expect(genericCsv.detect(csvInput("", null))).toBe(false);
    expect(genericCsv.detect(csvInput("", ["name", "url"]))).toBe(false);
  });

  it("generic parse keeps rows without credentials as notes", () => {
    const text = [
      "title,url,login,password,notes,folder,totp",
      "Plain note,,,,remember this,Misc,",
      "With login,https://x.example,u,p,,Secrets,JBSWY3DPEHPK3PXP",
    ].join("\n");
    const result = genericCsv.parse(csvInput(text, []));
    expect(result.items[0]?.kind).toBe("note");
    expect(result.items[0]?.folder).toBe("Misc");
    expect(result.items[0]?.notes).toBe("remember this");
    const login = result.items[1];
    if (login?.kind !== "login") throw new Error("expected login");
    expect(login.totp).toBe("JBSWY3DPEHPK3PXP");
  });
});

describe("Bitwarden JSON extras", () => {
  it("throws when forced onto a non-Bitwarden file", () => {
    expect(() =>
      bitwardenJson.parse({
        fileName: "x.json",
        text: "{}",
        headers: null,
        bytes: null, json: { hello: "world" },
      }),
    ).toThrow(/not a Bitwarden JSON export/);
  });

  it("skips item types it has no home for, with a reason", () => {
    const result = bitwardenJson.parse({
      fileName: "x.json",
      text: "",
      headers: null,
      bytes: null,
      json: {
        encrypted: false,
        items: [{ type: 99, name: "Mystery" }],
      },
    });
    expect(result.items).toHaveLength(0);
    expect(result.skipped[0]?.reason).toMatch(
      /Unsupported Bitwarden item type/,
    );
  });

  it("drops unknown folder ids and unknown URI match rules honestly", () => {
    const result = bitwardenJson.parse({
      fileName: "x.json",
      text: "",
      headers: null,
      bytes: null,
      json: {
        encrypted: false,
        items: [
          {
            type: 1,
            name: "Login",
            folderId: "no-such-folder",
            login: {
              username: "u",
              uris: [
                { uri: "https://a.example", match: 42 },
                { uri: "https://b.example", match: "domain" },
              ],
            },
          },
        ],
      },
    });
    const item = result.items[0];
    expect(item?.folder).toBeNull();
    if (item?.kind !== "login") throw new Error("expected login");
    expect(item.uris.map((u) => u.match)).toEqual(["domain", "domain"]);
  });

  it("warns in the singular for one imported identity", () => {
    const result = bitwardenJson.parse({
      fileName: "x.json",
      text: "",
      headers: null,
      bytes: null,
      json: {
        encrypted: false,
        items: [{ type: 4, name: "ID", identity: { firstName: "Ada" } }],
      },
    });
    expect(result.warnings[0]).toMatch(/^1 identity was/);
  });

  it("names nameless CSV rows Untitled", () => {
    const text = "name,login_username,login_password\n,u,p";
    const result = bitwardenCsv.parse(csvInput(text, []));
    expect(result.items[0]?.name).toBe("Untitled");
  });
});

describe("1Password 1PUX extras", () => {
  function pux(items: JsonValue[]): JsonObject {
    return {
      accounts: [
        {
          vaults: [{ attrs: { name: "Personal" }, items }],
        },
      ],
    };
  }

  function parsePux(json: BoundaryValue) {
    return onepasswordPux.parse({
      fileName: "export.1pux",
      text: "",
      headers: null,
      json,
      bytes: null,
    });
  }

  it("throws when forced onto a non-1PUX file", () => {
    expect(() => parsePux({ nope: true })).toThrow(/1Password export/);
  });

  it("keeps an unknown category as a note", () => {
    const result = parsePux(
      pux([
        {
          item: {
            categoryUuid: "099",
            overview: { title: "Driver license" },
            details: {},
          },
        },
      ]),
    );
    expect(result.items[0]?.kind).toBe("note");
  });

  it("reads a password-only item from details.password", () => {
    const result = parsePux(
      pux([
        {
          item: {
            categoryUuid: "005",
            overview: { title: "Wifi" },
            details: { password: "hunter2" },
          },
        },
      ]),
    );
    const item = result.items[0];
    if (item?.kind !== "login") throw new Error("expected login");
    expect(item.password).toBe("hunter2");
  });

  it("reads dates, emails, addresses, and plain strings from section fields", () => {
    const result = parsePux(
      pux([
        {
          item: {
            categoryUuid: "003",
            overview: { title: "Identity" },
            details: {
              sections: [
                {
                  title: "Details",
                  fields: [
                    { title: "born", value: { date: 1_700_000_000 } },
                    {
                      title: "mail",
                      value: { email: { email_address: "a@b.example" } },
                    },
                    {
                      title: "home",
                      value: { address: { street: "1 Main", zip: "12345" } },
                    },
                    { title: "nick", value: { string: "ada" } },
                    { title: "expiry", value: { monthYear: 202904 } },
                    { title: "empty", value: { unknown: 1 } },
                    { title: "plain", value: "direct string" },
                    { title: "nothing", value: null },
                  ],
                },
              ],
            },
          },
        },
      ]),
    );
    const fields = result.items[0]?.fields ?? [];
    const byName = new Map(fields.map((f) => [f.name, f.value]));
    expect(byName.get("Details · born")).toBe("2023-11-14T22:13:20.000Z");
    expect(byName.get("Details · mail")).toBe("a@b.example");
    expect(byName.get("Details · home")).toBe("1 Main, 12345");
    expect(byName.get("Details · nick")).toBe("ada");
    expect(byName.get("Details · expiry")).toBe("202904");
    expect(byName.get("Details · plain")).toBe("direct string");
    // Empty values produce no field at all.
    expect(byName.has("Details · empty")).toBe(false);
    expect(byName.has("Details · nothing")).toBe(false);
  });

  it("maps card brand and unparseable expiry to the right slots", () => {
    const result = parsePux(
      pux([
        {
          item: {
            categoryUuid: "002",
            overview: { title: "Card" },
            details: {
              sections: [
                {
                  title: "",
                  fields: [
                    { title: "card type", value: "Visa" },
                    { title: "expires", value: "soon-ish" },
                    { title: "verification number", value: "123" },
                  ],
                },
              ],
            },
          },
        },
      ]),
    );
    const card = result.items[0];
    if (card?.kind !== "card") throw new Error("expected card");
    expect(card.brand).toBe("Visa");
    expect(card.code).toBe("123");
    // Not YYYYMM, so it becomes a plain field instead of expMonth/expYear.
    expect(card.expMonth).toBe("");
    expect(card.fields.some((f) => f.value === "soon-ish")).toBe(true);
  });

  it("warns in the singular for one trashed item", () => {
    const result = parsePux(
      pux([
        { item: { trashed: true, overview: { title: "Gone" }, details: {} } },
      ]),
    );
    expect(result.items).toHaveLength(0);
    expect(result.warnings[0]).toMatch(/^1 item was/);
  });
});

describe("1Password CSV extras", () => {
  it("keeps a row with no credential at all as a note", () => {
    const text = "title,password,username,url,tags\nJust a note,,,,";
    const result = onepasswordCsv.parse(csvInput(text, []));
    expect(result.items[0]?.kind).toBe("note");
    expect(result.items[0]?.name).toBe("Just a note");
  });

  it("names a blank row Untitled", () => {
    const text = "title,password,username,url\n,p,u,";
    const result = onepasswordCsv.parse(csvInput(text, []));
    expect(result.items[0]?.name).toBe("Untitled");
  });
});

describe("Proton Pass extras", () => {
  function proton(items: JsonValue[]): JsonObject {
    return { vaults: { v1: { name: "Personal", items } } };
  }

  function parseProton(json: BoundaryValue) {
    return protonpassJson.parse({
      fileName: "proton.json",
      text: "",
      headers: null,
      json,
      bytes: null,
    });
  }

  it("throws when forced onto a non-Proton or encrypted file", () => {
    expect(() => parseProton({ nope: true })).toThrow(/not a Proton Pass/);
    expect(() => parseProton({ ...proton([]), encrypted: true })).toThrow(
      /encrypted/,
    );
  });

  it("reads a credit card with its MMYYYY expiry and hidden PIN", () => {
    const result = parseProton(
      proton([
        {
          data: {
            type: "creditCard",
            metadata: { name: "Travel" },
            content: {
              cardholderName: "A. Rowan",
              number: "4111111111111111",
              verificationNumber: "123",
              expirationDate: "042029",
              pin: "9876",
            },
          },
        },
      ]),
    );
    const card = result.items[0];
    if (card?.kind !== "card") throw new Error("expected card");
    expect(card.expMonth).toBe("04");
    expect(card.expYear).toBe("2029");
    expect(card.fields).toEqual([{ name: "PIN", value: "9876", hidden: true }]);
  });

  it("ignores an expiry that is not MMYYYY", () => {
    const result = parseProton(
      proton([
        {
          data: {
            type: "creditCard",
            metadata: { name: "Card" },
            content: { expirationDate: "April 2029" },
          },
        },
      ]),
    );
    if (result.items[0]?.kind !== "card") throw new Error("expected card");
    expect(result.items[0].expYear).toBe("");
  });

  it("records aliases as notes and says so once", () => {
    const result = parseProton(
      proton([
        {
          aliasEmail: "shop@alias.example",
          data: { type: "alias", metadata: { name: "Shopping alias" } },
        },
      ]),
    );
    expect(result.items[0]?.kind).toBe("note");
    expect(result.items[0]?.fields).toEqual([
      { name: "Alias address", value: "shop@alias.example", hidden: false },
    ]);
    expect(result.warnings[0]).toMatch(/^1 email alias became/);
  });

  it("keeps unknown item types as plain notes", () => {
    const result = parseProton(
      proton([{ data: { type: "sshKey", metadata: { name: "Deploy key" } } }]),
    );
    expect(result.items[0]?.kind).toBe("note");
  });

  it("feeds a totp extra field into a login that has none yet", () => {
    const result = parseProton(
      proton([
        {
          data: {
            type: "login",
            metadata: { name: "Mail" },
            content: { itemEmail: "a@b.example" },
            extraFields: [
              {
                fieldName: "2FA",
                type: "totp",
                data: { totpUri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" },
              },
              {
                fieldName: "Security question",
                type: "hidden",
                data: { content: "first pet" },
              },
            ],
          },
        },
      ]),
    );
    const login = result.items[0];
    if (login?.kind !== "login") throw new Error("expected login");
    expect(login.totp).toBe("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP");
    expect(login.username).toBe("a@b.example");
    expect(login.fields).toEqual([
      { name: "Security question", value: "first pet", hidden: true },
    ]);
  });

  it("warns in the singular for one trashed item", () => {
    const result = parseProton(
      proton([
        { state: 2, data: { type: "note", metadata: { name: "Gone" } } },
      ]),
    );
    expect(result.warnings[0]).toMatch(/^1 item was/);
  });
});
