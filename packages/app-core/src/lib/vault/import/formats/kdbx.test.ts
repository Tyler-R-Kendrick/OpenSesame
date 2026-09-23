import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import type { ParseInput, ParseResult } from "../types.js";
import { hasKdbxMagic, keepassKdbx, sanitiseSegment } from "./kdbx.js";

/**
 * The password the shared conformance fixture is sealed with. Frozen by the
 * build spec so the Rust writer and this reader agree without coordinating.
 */
const FIXTURE_PASSWORD = "correct horse battery staple";

const FIXTURE_DIR = new URL(
  "../../../../../../../fixtures/kdbx/",
  import.meta.url,
);
const FIXTURE_KDBX = fileURLToPath(new URL("roundtrip.kdbx", FIXTURE_DIR));
const FIXTURE_EXPECTED = fileURLToPath(
  new URL("roundtrip.expected.json", FIXTURE_DIR),
);

function input(bytes: Uint8Array, password?: string): ParseInput {
  const parsedInput: ParseInput = {
    fileName: "roundtrip.kdbx",
    text: "",
    headers: null,
    json: null,
    bytes,
  };
  if (password !== undefined) parsedInput.password = password;
  return parsedInput;
}

describe("hasKdbxMagic", () => {
  it("accepts the KDBX signature and nothing else", () => {
    expect(
      hasKdbxMagic(
        new Uint8Array([0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5, 0x00]),
      ),
    ).toBe(true);
    // KDB1, whose second signature differs in one byte.
    expect(
      hasKdbxMagic(
        new Uint8Array([0x03, 0xd9, 0xa2, 0x9a, 0x65, 0xfb, 0x4b, 0xb5]),
      ),
    ).toBe(false);
  });

  it("never throws on short, empty, or absent input", () => {
    expect(hasKdbxMagic(null)).toBe(false);
    expect(hasKdbxMagic(new Uint8Array())).toBe(false);
    expect(hasKdbxMagic(new Uint8Array([0x03, 0xd9]))).toBe(false);
  });
});

describe("keepassKdbx.detect", () => {
  it("claims a KDBX blob and declines everything else without throwing", () => {
    const base = { fileName: "x", text: "", headers: null, json: null };
    expect(
      keepassKdbx.detect({
        ...base,
        bytes: new Uint8Array([0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5]),
      }),
    ).toBe(true);
    expect(keepassKdbx.detect({ ...base, bytes: null })).toBe(false);
    expect(
      keepassKdbx.detect({
        ...base,
        text: "name,password",
        headers: ["name", "password"],
        bytes: null,
      }),
    ).toBe(false);
    expect(keepassKdbx.detect({ ...base, bytes: new Uint8Array(64) })).toBe(
      false,
    );
  });
});

describe("sanitiseSegment", () => {
  it("keeps an ordinary name untouched", () => {
    expect(sanitiseSegment("Work Email")).toBe("Work Email");
    expect(sanitiseSegment("  padded  ")).toBe("padded");
  });

  it("turns a separator inside a name into an underscore", () => {
    // Otherwise a title could forge a level of folder nesting.
    expect(sanitiseSegment("a/b")).toBe("a_b");
    expect(sanitiseSegment("a\\b")).toBe("a_b");
  });

  it("turns control characters into underscores", () => {
    expect(sanitiseSegment("Tab\there")).toBe("Tab_here");
    expect(sanitiseSegment("a\u0000b\u0007c")).toBe("a_b_c");
  });

  it("names a segment that sanitises away", () => {
    expect(sanitiseSegment("")).toBe("_");
    expect(sanitiseSegment("   ")).toBe("_");
  });

  it("never lets a dots-only segment mean the parent directory", () => {
    expect(sanitiseSegment(".")).toBe("_");
    expect(sanitiseSegment("..")).toBe("__");
    expect(sanitiseSegment("...")).toBe("___");
    // A name that merely contains dots is left alone.
    expect(sanitiseSegment("v1.2.3")).toBe("v1.2.3");
  });
});

describe("keepassKdbx.parse before a password is given", () => {
  const stub = new Uint8Array([
    0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5, 0x00,
  ]);

  it("asks for one rather than failing", async () => {
    const result = await keepassKdbx.parse(input(stub));
    expect(result.needsPassword).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.warnings[0]).toMatch(/never stored or sent/);
  });

  it("treats an empty password as no password rather than a wrong one", async () => {
    const result = await keepassKdbx.parse(input(stub, ""));
    expect(result.needsPassword).toBe(true);
  });

  it("refuses a blob that is not a database at all", async () => {
    await expect(
      keepassKdbx.parse(input(new Uint8Array([1, 2, 3, 4]), "anything")),
    ).rejects.toThrow(/not a KeePass database/);
    await expect(
      keepassKdbx.parse(input(new Uint8Array(), "anything")),
    ).rejects.toThrow(/not a KeePass database/);
  });
});

/**
 * The sealed-store `Entry` shape, which is the form
 * `fixtures/kdbx/roundtrip.expected.json` is written in.
 *
 * `crates/kdbx-bridge` maps a KDBX entry to `{ secret, trailer, otp }` keyed
 * by store path; this page maps the same entry to a `DraftItem`. The two
 * target models differ, so the conformance assertion is made by projecting
 * this side's drafts back into that shape. Every value — secret, username,
 * URL, notes with their line breaks, extra fields, TOTP URI, group path, and
 * collision suffix — still has to come out identical.
 */
type StoreEntry = { secret: string; trailer: string[]; otp: string | null };

/** `crates/kdbx-bridge`'s `sanitize_key`: `:` and control become `_`. */
function sanitiseKey(raw: string): string {
  const replaced = [...raw]
    .map((ch) => (ch === ":" || /\p{Cc}/u.test(ch) ? "_" : ch))
    .join("")
    .trim();
  return replaced === "" ? "field" : replaced;
}

/** `render_trailer`: `key: first`, then two spaces before each later line. */
function trailerLines(pairs: [string, string][]): string[] {
  const out: string[] = [];
  for (const [key, value] of pairs) {
    const lines = value.replace(/\r\n?/gu, "\n").split("\n");
    out.push(`${key}: ${lines[0] ?? ""}`);
    for (const line of lines.slice(1)) out.push(`  ${line}`);
  }
  return out;
}

function toStoreEntries(result: ParseResult) {
  const out = new Map<string, StoreEntry>();
  for (const item of result.items) {
    const path =
      item.folder === null ? item.name : `${item.folder}/${item.name}`;
    const pairs: [string, string][] = [];
    let secret = "";
    let otp: string | null = null;
    if (item.kind === "login") {
      secret = item.password;
      otp = item.totp === "" ? null : item.totp;
      if (item.username !== "") pairs.push(["login", item.username]);
      const uri = item.uris[0];
      if (uri !== undefined) pairs.push(["url", uri.uri]);
    }
    if (item.notes !== "") pairs.push(["notes", item.notes]);
    for (const field of item.fields) {
      pairs.push([sanitiseKey(field.name), field.value]);
    }
    out.set(path, { secret, trailer: trailerLines(pairs), otp });
  }
  return out;
}

/**
 * The one place this reader provably cannot reproduce the Rust mapping, and
 * why.
 *
 * `crates/kdbx-bridge` writes a title containing a raw TAB, and sanitises it
 * to `Tab_here`. kdbxweb parses the inner XML with `@xmldom/xmldom`, which
 * drops a raw TAB inside a text node — a kdbxweb-side limitation, not a fault
 * in the file: a database written by kdbxweb and read straight back by
 * kdbxweb loses the same character, which the test below pins.
 *
 * The entry is therefore reconciled by name only. Its secret, trailer, and
 * TOTP are still compared strictly, as is every other entry in the fixture.
 * If kdbxweb ever preserves the tab, the pinning test fails and this entry
 * comes out of the map.
 */
const READER_LIMITATIONS = new Map([
  ["Weird_Name/Tab_here", "Weird_Name/Tabhere"],
]);

describe("kdbxweb's own handling of a tab inside a field value", () => {
  it("drops it while parsing, which is why the fixture is reconciled", async () => {
    const kdbxweb = await import("kdbxweb");
    // `\u0009` is a legal XML character that a conforming parser preserves in
    // character data. `@xmldom/xmldom`, which kdbxweb parses the inner XML
    // with, does not — so no KDBX field value read through kdbxweb can hold
    // one, whoever wrote the database.
    const parsed = kdbxweb.XmlUtils.parse("<Root><V>Tab\u0009here</V></Root>");
    expect(parsed.documentElement?.textContent).toBe("Tabhere");
  });
});

describe("keepassKdbx against the shared conformance fixture", () => {
  /**
   * `fixtures/kdbx/roundtrip.kdbx` is written by `crates/kdbx-bridge`, whose
   * KDBX4 **writer is experimental**. This is the cross-implementation guard
   * on it: an independent reader (kdbxweb) opens the same bytes and has to
   * produce the same mapped entries. A round-trip test inside one
   * implementation would happily agree with its own bug.
   */
  let result: ParseResult;

  beforeAll(async () => {
    expect(
      existsSync(FIXTURE_KDBX),
      `missing shared fixture ${FIXTURE_KDBX}`,
    ).toBe(true);
    const bytes = new Uint8Array(readFileSync(FIXTURE_KDBX));
    result = await keepassKdbx.parse(input(bytes, FIXTURE_PASSWORD));
  }, 60_000);

  it("opens the Rust-written database with the frozen password", () => {
    expect(result.source).toBe("keepass-kdbx");
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("maps to exactly the entries roundtrip.expected.json describes", () => {
    const expected: { items: Record<string, StoreEntry> } = JSON.parse(
      readFileSync(FIXTURE_EXPECTED, "utf8"),
    );
    const reconciled = Object.fromEntries(
      Object.entries(expected.items).map(([path, entry]) => [
        READER_LIMITATIONS.get(path) ?? path,
        entry,
      ]),
    );
    expect(toStoreEntries(result)).toEqual(new Map(Object.entries(reconciled)));
  });

  it("puts an entry from a nested group under the joined group path", () => {
    const nested = result.items.find((item) => item.name === "Example Mail");
    expect(nested?.folder).toBe("Personal/Email");
  });

  it("carries every field type off one entry", () => {
    const item = result.items.find((row) => row.name === "Example Mail");
    if (item?.kind !== "login") throw new Error("expected a login");
    expect(item.username).toBe("alice@example.com");
    expect(item.password).toBe("fixture-password-one");
    expect(item.uris[0]?.uri).toBe("https://mail.example.com/");
    // Blank lines inside a note survive.
    expect(item.notes).toBe(
      "First line of the note.\nSecond line.\n\nFourth line, after a blank one.",
    );
    // A KeePassXC `otp` field already holds a URI, which is kept verbatim.
    expect(item.totp).toBe(
      "otpauth://totp/Example%20Mail?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example&digits=6&period=30&algorithm=SHA1",
    );
    // An unrecognised string field survives with its name and value intact.
    expect(item.fields).toContainEqual({
      name: "Recovery Code",
      value: "abcd-efgh-ijkl",
      hidden: false,
    });
  });

  it("builds the same TOTP URI from TimeOtp attributes as the Rust mapping", () => {
    const item = result.items.find((row) => row.name === "Deploy Token");
    if (item?.kind !== "login") throw new Error("expected a login");
    expect(item.totp).toBe(
      "otpauth://totp/Deploy%20Token?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&period=60&algorithm=SHA256",
    );
    // The TimeOtp-* attributes are consumed, not left lying about as fields.
    expect(item.fields.map((field) => field.name)).toEqual(["API Key"]);
    expect(item.fields[0]?.hidden).toBe(true);
  });

  it("leaves an entry in the root group unfiled", () => {
    const item = result.items.find((row) => row.name === "Root Note");
    expect(item?.folder).toBeNull();
    if (item?.kind !== "login") throw new Error("expected a login");
    expect(item.password).toBe("");
  });

  it("suffixes a colliding title instead of losing one of them", () => {
    const names = result.items.map((item) => item.name);
    expect(names).toContain("Example Mail");
    expect(names).toContain("Example Mail (2)");
  });

  it("sanitises a group name that carries a path separator", () => {
    const item = result.items.find((row) => row.folder === "Weird_Name");
    expect(item).toBeDefined();
    // The Rust side sanitises the tab in this title to `_`; see
    // READER_LIMITATIONS for why this reader never sees the tab at all.
    expect(item?.name).toBe("Tabhere");
  });

  it("rejects the wrong password with a message that names the cause", async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE_KDBX));
    await expect(
      keepassKdbx.parse(input(bytes, "not the password")),
    ).rejects.toThrow(/did not open the database/);
  }, 60_000);

  it("does not panic on a truncated database", async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE_KDBX)).slice(0, 200);
    await expect(
      keepassKdbx.parse(input(bytes, FIXTURE_PASSWORD)),
    ).rejects.toThrow(/could not be read|did not open the database/);
  }, 60_000);

  it("does not panic on a database with corrupted body bytes", async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE_KDBX));
    for (let index = bytes.length - 64; index < bytes.length; index += 1) {
      bytes[index] = (bytes[index] ?? 0) ^ 0xff;
    }
    await expect(
      keepassKdbx.parse(input(bytes, FIXTURE_PASSWORD)),
    ).rejects.toThrow(Error);
  }, 60_000);
});
