import { overlapCast } from "@opensesame/os-domain";
/**
 * Fixtures here are trimmed from the real thing. Column names, casing, and
 * sentinel values (LastPass's `http://sn`, 1Password's `{"concealed":…}`)
 * are reproduced exactly, because those are what detection turns on.
 */

import { describe, expect, it } from "vitest";
import { readHeaderRow } from "./csv.js";
import {
  ADAPTERS,
  type DetectInput,
  type DraftItem,
  type DraftLogin,
  ImportError,
  type SourceId,
  detectFormat,
  parseImport,
  summarise,
} from "./index.js";
import { normaliseTotp } from "./types.js";

/** Mirrors what `readImportFile` builds, without needing a File. */
function input(fileName: string, text: string): DetectInput {
  let json = null;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  const headers =
    json === null && text.split("\n")[0]?.includes(",")
      ? readHeaderRow(text)
      : null;
  return { fileName, text, headers, json };
}

function expectDetected(file: DetectInput, id: SourceId): void {
  expect(detectFormat(file)?.id).toBe(id);
}

function loginNamed(items: readonly DraftItem[], name: string): DraftLogin {
  const found = items.find(
    (item): item is DraftLogin => item.kind === "login" && item.name === name,
  );
  if (!found) throw new Error(`No item named ${name}`);
  return found;
}

// —— Bitwarden ————————————————————————————————————————————————

const BITWARDEN_JSON = JSON.stringify({
  encrypted: false,
  folders: [{ id: "f1", name: "Work" }],
  items: [
    {
      id: "i1",
      folderId: "f1",
      type: 1,
      name: "GitHub",
      notes: "recovery codes in the safe",
      favorite: true,
      fields: [
        { name: "Employee ID", value: "E-42", type: 0 },
        { name: "Recovery", value: "abcd-efgh", type: 1 },
      ],
      login: {
        username: "ada",
        password: "hunter2",
        totp: "JBSWY3DPEHPK3PXP",
        uris: [
          { match: null, uri: "https://github.com" },
          { match: 3, uri: "https://gist.github.com" },
        ],
      },
      creationDate: "2023-01-02T03:04:05.000Z",
      revisionDate: "2024-05-06T07:08:09.000Z",
    },
    { id: "i2", folderId: null, type: 2, name: "Door code", notes: "1234" },
    {
      id: "i3",
      folderId: null,
      type: 3,
      name: "Visa",
      card: {
        cardholderName: "Ada Lovelace",
        brand: "Visa",
        number: "4111111111111111",
        expMonth: "11",
        expYear: "2029",
        code: "123",
      },
    },
    {
      id: "i4",
      type: 4,
      name: "Passport",
      identity: { firstName: "Ada", passportNumber: "X123" },
    },
  ],
});

describe("Bitwarden JSON", () => {
  const file = input("bitwarden_export.json", BITWARDEN_JSON);

  it("is detected", () => expectDetected(file, "bitwarden-json"));

  it("maps every item type", () => {
    const { items } = parseImport(file);
    expect(items.map((i) => i.kind)).toEqual(["login", "note", "card", "note"]);
  });

  it("carries folder, favourite, notes, totp, and dates onto a login", () => {
    const login = loginNamed(parseImport(file).items, "GitHub");
    expect(login.folder).toBe("Work");
    expect(login.favorite).toBe(true);
    expect(login.username).toBe("ada");
    expect(login.password).toBe("hunter2");
    expect(login.totp).toBe("JBSWY3DPEHPK3PXP");
    expect(login.notes).toBe("recovery codes in the safe");
    expect(login.createdAt).toBe("2023-01-02T03:04:05.000Z");
    expect(login.updatedAt).toBe("2024-05-06T07:08:09.000Z");
  });

  it("preserves the hidden flag on custom fields", () => {
    const login = loginNamed(parseImport(file).items, "GitHub");
    expect(login.fields).toEqual([
      { name: "Employee ID", value: "E-42", hidden: false },
      { name: "Recovery", value: "abcd-efgh", hidden: true },
    ]);
  });

  it("translates Bitwarden's numeric uri match rules", () => {
    const login = loginNamed(parseImport(file).items, "GitHub");
    expect(login.uris).toEqual([
      { uri: "https://github.com", match: "domain" },
      { uri: "https://gist.github.com", match: "exact" },
    ]);
  });

  it("keeps an identity as a note with its values as fields, and says so", () => {
    const result = parseImport(file);
    const passport = result.items.find((i) => i.name === "Passport");
    expect(passport?.kind).toBe("note");
    expect(passport?.fields).toContainEqual({
      name: "Passport Number",
      value: "X123",
      hidden: true,
    });
    expect(result.warnings.join(" ")).toContain("identity was imported");
  });

  it("refuses an encrypted export with an actionable message", () => {
    const encrypted = input(
      "x.json",
      JSON.stringify({ encrypted: true, items: [] }),
    );
    expect(() => parseImport(encrypted)).toThrow(/password-protected/u);
  });
});

const BITWARDEN_CSV = `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
Work,1,login,GitHub,"a note","Employee ID: E-42
Recovery: abcd",0,https://github.com,ada,hunter2,JBSWY3DPEHPK3PXP
,0,note,Door code,"1234",,0,,,,`;

describe("Bitwarden CSV", () => {
  const file = input("bitwarden_export.csv", BITWARDEN_CSV);

  it("is detected ahead of the generic reader", () =>
    expectDetected(file, "bitwarden-csv"));

  it("splits the packed fields column", () => {
    const login = loginNamed(parseImport(file).items, "GitHub");
    expect(login.fields).toEqual([
      { name: "Employee ID", value: "E-42", hidden: false },
      { name: "Recovery", value: "abcd", hidden: false },
    ]);
  });

  it("recognises the note type", () => {
    const { items } = parseImport(file);
    expect(items[1]?.kind).toBe("note");
  });

  it("warns that the CSV is the lossy option", () => {
    expect(parseImport(file).warnings.join(" ")).toContain("Export as .json");
  });
});

// —— 1Password ————————————————————————————————————————————————

const PUX = JSON.stringify({
  accounts: [
    {
      attrs: { name: "Personal" },
      vaults: [
        {
          attrs: { name: "Private" },
          items: [
            {
              item: {
                uuid: "u1",
                favIndex: 1,
                createdAt: 1672628645,
                updatedAt: 1714982889,
                trashed: false,
                categoryUuid: "001",
                details: {
                  loginFields: [
                    { designation: "username", value: "ada" },
                    { designation: "password", value: "hunter2" },
                  ],
                  notesPlain: "a note",
                  sections: [
                    {
                      title: "Security",
                      fields: [
                        {
                          title: "one-time password",
                          value: {
                            totp: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
                          },
                        },
                        { title: "PIN", value: { concealed: "9999" } },
                      ],
                    },
                  ],
                },
                overview: {
                  title: "GitHub",
                  url: "https://github.com",
                  urls: [{ label: "website", url: "https://gist.github.com" }],
                  tags: ["dev"],
                },
              },
            },
            {
              item: {
                uuid: "u2",
                trashed: false,
                categoryUuid: "002",
                details: {
                  sections: [
                    {
                      title: "",
                      fields: [
                        {
                          title: "cardholder name",
                          value: { string: "Ada Lovelace" },
                        },
                        {
                          title: "number",
                          value: { creditCardNumber: "4111111111111111" },
                        },
                        {
                          title: "verification number",
                          value: { concealed: "123" },
                        },
                        { title: "expiry date", value: { monthYear: 202911 } },
                      ],
                    },
                  ],
                },
                overview: { title: "Visa" },
              },
            },
            {
              item: {
                uuid: "u3",
                trashed: true,
                categoryUuid: "003",
                details: {},
                overview: { title: "Old thing" },
              },
            },
          ],
        },
      ],
    },
  ],
});

describe("1Password 1PUX", () => {
  const file = input("export.data", PUX);

  it("is detected", () => expectDetected(file, "1password-1pux"));

  it("maps a login with both urls, the vault as a folder, and the totp", () => {
    const login = loginNamed(parseImport(file).items, "GitHub");
    expect(login.username).toBe("ada");
    expect(login.password).toBe("hunter2");
    expect(login.folder).toBe("Private");
    expect(login.favorite).toBe(true);
    expect(login.totp).toBe("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP");
    expect(login.uris.map((u) => u.uri)).toEqual([
      "https://github.com",
      "https://gist.github.com",
    ]);
  });

  it("keeps a concealed section field hidden and prefixed by its section", () => {
    const login = loginNamed(parseImport(file).items, "GitHub");
    expect(login.fields).toContainEqual({
      name: "Security · PIN",
      value: "9999",
      hidden: true,
    });
  });

  it("keeps tags", () => {
    const login = loginNamed(parseImport(file).items, "GitHub");
    expect(login.fields).toContainEqual({
      name: "Tag",
      value: "dev",
      hidden: false,
    });
  });

  it("reassembles a credit card from its section fields", () => {
    const card = parseImport(file).items.find((i) => i.name === "Visa");
    expect(card).toMatchObject({
      kind: "card",
      cardholder: "Ada Lovelace",
      number: "4111111111111111",
      code: "123",
      expMonth: "11",
      expYear: "2029",
    });
  });

  it("leaves trashed items out and reports them", () => {
    const result = parseImport(file);
    expect(result.items.some((i) => i.name === "Old thing")).toBe(false);
    expect(result.warnings.join(" ")).toContain("1Password trash");
  });
});

const ONEPASSWORD_CSV = `Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes
GitHub,https://github.com,ada,hunter2,otpauth://totp/x?secret=JBSWY3DPEHPK3PXP,true,false,dev,a note
Old,,,,,false,true,,`;

describe("1Password CSV", () => {
  const file = input("1password.csv", ONEPASSWORD_CSV);

  it("is detected and not mistaken for Safari's", () =>
    expectDetected(file, "1password-csv"));

  it("skips archived rows with a stated reason", () => {
    const result = parseImport(file);
    expect(result.items).toHaveLength(1);
    expect(result.skipped[0]).toEqual({
      name: "Old",
      reason: "Archived in 1Password.",
    });
  });
});

// —— Browsers —————————————————————————————————————————————————

describe("Chromium browsers", () => {
  const file = input(
    "Chrome Passwords.csv",
    `name,url,username,password,note
github.com,https://github.com/login,ada,hunter2,
example.com,https://example.com/,bob,"pa,ss""word",a note`,
  );

  it("is detected", () => expectDetected(file, "chromium-csv"));

  it("survives a password containing a comma and a quote", () => {
    const login = loginNamed(parseImport(file).items, "example.com");
    expect(login.password).toBe('pa,ss"word');
  });

  it("states what a browser export cannot carry", () => {
    expect(parseImport(file).warnings.join(" ")).toContain(
      "no cards, notes, or 2FA seeds",
    );
  });
});

describe("Safari", () => {
  const file = input(
    "Passwords.csv",
    `Title,URL,Username,Password,Notes,OTPAuth
GitHub,https://github.com,ada,hunter2,,otpauth://totp/x?secret=JBSWY3DPEHPK3PXP`,
  );

  it("is detected", () => expectDetected(file, "apple-csv"));

  it("keeps the otpauth uri", () => {
    const login = loginNamed(parseImport(file).items, "GitHub");
    expect(login.totp).toBe("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP");
  });
});

describe("Firefox", () => {
  const file = input(
    "logins.csv",
    `"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"
"https://github.com","ada","hunter2",,"https://github.com","{abc}","1672628645000","1714982889000","1672628645000"`,
  );

  it("is detected", () => expectDetected(file, "firefox-csv"));

  it("names the item after the host, since Firefox exports no title", () => {
    const { items, warnings } = parseImport(file);
    expect(items[0]?.name).toBe("github.com");
    expect(warnings.join(" ")).toContain("no titles");
  });

  it("reads the password-changed timestamp for the health report", () => {
    const login: DraftLogin = overlapCast(parseImport(file).items[0]);
    expect(login.passwordChangedAt).toBe("2023-01-02T03:04:05.000Z");
  });
});

// —— Other managers ———————————————————————————————————————————

describe("LastPass", () => {
  const file = input(
    "lastpass_export.csv",
    `url,username,password,totp,extra,name,grouping,fav
https://github.com,ada,hunter2,JBSWY3DPEHPK3PXP,a note,GitHub,Work\\Dev,1
http://sn,,,,"NoteType:Server
Hostname:db.internal
Password:s3cret
Notes:the old box",DB box,Infra,0`,
  );

  it("is detected", () => expectDetected(file, "lastpass-csv"));

  it("flattens a nested group", () => {
    const login = loginNamed(parseImport(file).items, "GitHub");
    expect(login.folder).toBe("Work / Dev");
    expect(login.favorite).toBe(true);
  });

  it("turns the http://sn sentinel into a note", () => {
    const note = parseImport(file).items.find((i) => i.name === "DB box");
    expect(note?.kind).toBe("note");
  });

  it("unpacks a typed secure note into fields, concealing the password", () => {
    const note = parseImport(file).items.find((i) => i.name === "DB box");
    expect(note?.notes).toBe("the old box");
    expect(note?.fields).toContainEqual({
      name: "Hostname",
      value: "db.internal",
      hidden: false,
    });
    expect(note?.fields).toContainEqual({
      name: "Password",
      value: "s3cret",
      hidden: true,
    });
  });
});

describe("KeePassXC", () => {
  const file = input(
    "keepassxc.csv",
    `"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"
"Root/Work","GitHub","ada","hunter2","https://github.com","","JBSWY3DPEHPK3PXP","0","2024-05-06T07:08:09Z","2023-01-02T03:04:05Z"`,
  );

  it("is detected", () => expectDetected(file, "keepassxc-csv"));

  it("drops the Root prefix from the group", () => {
    expect(parseImport(file).items[0]?.folder).toBe("Work");
  });
});

describe("KeePass 2.x", () => {
  const file = input(
    "keepass.csv",
    `"Account","Login Name","Password","Web Site","Comments"
"GitHub","ada","hunter2","https://github.com","a note"`,
  );

  it("is detected", () => expectDetected(file, "keepass-csv"));

  it("maps its differently named columns", () => {
    const login: DraftLogin = overlapCast(parseImport(file).items[0]);
    expect(login).toMatchObject({
      name: "GitHub",
      username: "ada",
      password: "hunter2",
    });
    expect(login.uris[0]?.uri).toBe("https://github.com");
  });
});

describe("Dashlane", () => {
  it("reads the credentials file and names the sibling files", () => {
    const file = input(
      "credentials.csv",
      `username,username2,username3,title,password,note,url,category,otpSecret
ada,ada@work.test,,GitHub,hunter2,a note,https://github.com,Dev,JBSWY3DPEHPK3PXP`,
    );
    expectDetected(file, "dashlane-csv");
    const result = parseImport(file);
    const login: DraftLogin = overlapCast(result.items[0]);
    expect(login.folder).toBe("Dev");
    expect(login.totp).toBe("JBSWY3DPEHPK3PXP");
    expect(login.fields).toContainEqual({
      name: "Alternate username",
      value: "ada@work.test",
      hidden: false,
    });
    expect(result.warnings.join(" ")).toContain("one CSV per item type");
  });

  it("reads the payments file as cards", () => {
    const file = input(
      "payments.csv",
      `type,account_name,account_holder,cc_number,code,expiration_month,expiration_year,issuing_bank
credit_card,Visa,Ada Lovelace,4111111111111111,123,11,2029,Bank`,
    );
    expectDetected(file, "dashlane-csv");
    expect(parseImport(file).items[0]).toMatchObject({
      kind: "card",
      cardholder: "Ada Lovelace",
      number: "4111111111111111",
      expMonth: "11",
    });
  });
});

describe("NordPass", () => {
  const file = input(
    "nordpass.csv",
    `name,url,username,password,note,cardholdername,cardnumber,cvc,expirydate,zipcode,folder,full_name,phone_number,email,address1,address2,city,country,state
GitHub,https://github.com,ada,hunter2,,,,,,,Work,,,,,,,,
Visa,,,,,Ada Lovelace,4111111111111111,123,11/2029,SW1,Cards,,,,,,,,`,
  );

  it("is detected", () => expectDetected(file, "nordpass-csv"));

  it("splits one file into logins and cards", () => {
    const { items } = parseImport(file);
    expect(items.map((i) => i.kind)).toEqual(["login", "card"]);
    expect(items[1]).toMatchObject({ expMonth: "11", expYear: "2029" });
  });
});

describe("Proton Pass", () => {
  const file = input(
    "proton.json",
    JSON.stringify({
      version: "1.0.0",
      encrypted: false,
      vaults: {
        v1: {
          name: "Personal",
          items: [
            {
              state: 1,
              pinned: true,
              createTime: 1672628645,
              modifyTime: 1714982889,
              data: {
                type: "login",
                metadata: { name: "GitHub", note: "a note" },
                content: {
                  itemUsername: "ada",
                  password: "hunter2",
                  urls: ["https://github.com"],
                  totpUri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
                  passkeys: [{ keyId: "k1" }],
                },
                extraFields: [
                  {
                    fieldName: "Recovery",
                    type: "hidden",
                    data: { content: "abcd" },
                  },
                ],
              },
            },
            {
              state: 2,
              data: {
                type: "note",
                metadata: { name: "Trashed" },
                content: {},
              },
            },
          ],
        },
      },
    }),
  );

  it("is detected", () => expectDetected(file, "protonpass-json"));

  it("maps a login and keeps the vault as a folder", () => {
    const login = loginNamed(parseImport(file).items, "GitHub");
    expect(login).toMatchObject({
      username: "ada",
      password: "hunter2",
      folder: "Personal",
      favorite: true,
    });
    expect(login.fields).toContainEqual({
      name: "Recovery",
      value: "abcd",
      hidden: true,
    });
  });

  it("states plainly that a passkey could not come across", () => {
    const login = loginNamed(parseImport(file).items, "GitHub");
    expect(login.fields.find((f) => f.name === "Passkeys")?.value).toContain(
      "never leaves the device",
    );
  });

  it("leaves trashed items behind", () => {
    const result = parseImport(file);
    expect(result.items).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("Proton Pass trash");
  });
});

// —— Fallback and failure —————————————————————————————————————

describe("generic CSV", () => {
  const file = input(
    "mystery.csv",
    `Site Name,Web Address,Login,Secret,Remarks,Employee
GitHub,https://github.com,ada,hunter2,a note,E-42`,
  );

  it("is used only when nothing named matches", () =>
    expectDetected(file, "generic-csv"));

  it("maps columns by meaning and keeps unclaimed ones as fields", () => {
    const login: DraftLogin = overlapCast(parseImport(file).items[0]);
    expect(login).toMatchObject({
      name: "GitHub",
      username: "ada",
      password: "hunter2",
      notes: "a note",
    });
    expect(login.fields).toContainEqual({
      name: "employee",
      value: "E-42",
      hidden: false,
    });
  });

  it("tells the user to check the preview", () => {
    expect(parseImport(file).warnings.join(" ")).toContain("matched by name");
  });

  it("recognises common synonyms for the username column", () => {
    for (const header of ["Sign-in", "E-mail", "User ID", "Login Name"]) {
      const csv = input("x.csv", `Entry,${header},Secret\nGitHub,ada,hunter2`);
      const login: DraftLogin = overlapCast(parseImport(csv).items[0]);
      expect(login.username, header).toBe("ada");
    }
  });

  it("never lets one column fill two roles", () => {
    // "Site Name" matches both the name and the url patterns.
    const csv = input(
      "x.csv",
      "Site Name,Web Address,Login,Secret\nGitHub,https://github.com,ada,hunter2",
    );
    const login: DraftLogin = overlapCast(parseImport(csv).items[0]);
    expect(login.name).toBe("GitHub");
    expect(login.uris[0]?.uri).toBe("https://github.com");
  });
});

describe("failure", () => {
  it("refuses a file that resembles no export", () => {
    const file = input("notes.txt", "just some prose, nothing tabular");
    expect(detectFormat(file)).toBeNull();
    expect(() => parseImport(file)).toThrow(ImportError);
  });

  it("refuses a well-formed file that holds no items", () => {
    const file = input("empty.csv", "name,url,username,password");
    expect(() => parseImport(file)).toThrow(/held no items/u);
  });

  it("reports a truncated quoted field rather than importing half a row", () => {
    const file = input(
      "bad.csv",
      'name,url,username,password\n"GitHub,https://x',
    );
    expect(() => parseImport(file)).toThrow(/ends inside a quoted value/u);
  });

  it("lets a forced format override a wrong guess", () => {
    const file = input(
      "renamed.csv",
      `name,url,username,password
GitHub,https://github.com,ada,hunter2`,
    );
    expect(parseImport(file, "generic-csv").source).toBe("generic-csv");
  });
});

// —— The registry itself ——————————————————————————————————————

describe("adapter registry", () => {
  it("gives every adapter the metadata the UI renders", () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.label, adapter.id).not.toBe("");
      expect(adapter.shortName, adapter.id).not.toBe("");
      expect(adapter.hint, adapter.id).not.toBe("");
      // A folder name is built from shortName, so it must not carry the
      // extension suffix or a list of four browsers.
      expect(adapter.shortName, adapter.id).not.toMatch(/\(\./u);
      expect(adapter.shortName.length, adapter.id).toBeLessThan(20);
    }
  });

  it("has no duplicate ids", () => {
    const ids = ADAPTERS.map((adapter) => adapter.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the catch-all last so it cannot shadow a named format", () => {
    expect(ADAPTERS.at(-1)?.id).toBe("generic-csv");
  });

  it("survives being shown input of the wrong shape", () => {
    const nonsense = [
      input("a.txt", ""),
      input("b.json", "{}"),
      input("c.json", "[]"),
      input("d.json", '{"items":null}'),
      input("e.csv", ",,,\n,,,"),
      input("f.bin", "\u0000\u0001\u0002"),
    ];
    for (const file of nonsense) {
      for (const adapter of ADAPTERS) {
        expect(() => adapter.detect(file), adapter.id).not.toThrow();
      }
    }
  });
});

// —— Normalisation ————————————————————————————————————————————

describe("normaliseTotp", () => {
  it("passes an otpauth uri through", () => {
    expect(normaliseTotp("otpauth://totp/x?secret=ABC")).toBe(
      "otpauth://totp/x?secret=ABC",
    );
  });

  it("strips the spacing exporters add to a base32 seed", () => {
    expect(normaliseTotp("jbsw y3dp ehpk 3pxp")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("rejects something that is not a seed", () => {
    expect(normaliseTotp("none")).toBe("");
    expect(normaliseTotp("")).toBe("");
  });
});

describe("summarise", () => {
  it("counts by kind and reports what is missing", () => {
    const { items } = parseImport(input("bw.json", BITWARDEN_JSON));
    const summary = summarise(items);
    expect(summary).toMatchObject({
      logins: 1,
      cards: 1,
      notes: 2,
      withTotp: 1,
    });
    expect(summary.folders).toEqual(["Work"]);
  });
});
