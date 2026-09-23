import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import type { ParseResult } from "../types.js";
import { keepassKdbx } from "./kdbx.js";

/**
 * Characterization snapshots of what a KeePass database becomes.
 *
 * The unit tests beside this file pin the individual rules. These pin the
 * whole `ParseResult` — every item, every skipped record, every warning — for
 * databases that exercise the awkward corners, so a change to the mapping has
 * to be looked at and accepted rather than discovered by a user whose vault
 * came out subtly different.
 *
 * This surface drifts silently in a way a type check cannot catch. A field
 * that quietly stops being marked hidden puts a password in plain sight in the
 * item list; a group path that quietly changes shape scatters a hundred
 * entries into folders nobody asked for; a TOTP URI whose parameters quietly
 * change generates codes that do not work, and the user finds out when they
 * are locked out of something.
 *
 * The databases are built here rather than committed, so the fixtures are
 * readable as code and cannot rot into "some bytes someone made once".
 * `fixtures/kdbx/roundtrip.kdbx` — the cross-implementation fixture written by
 * `crates/kdbx-bridge` — is snapshotted too, at the end.
 *
 * If one of these fails, read the diff before updating it.
 */

const PASSWORD = "snapshot-password";

type Kdbxweb = typeof import("kdbxweb");

let kdbxweb: Kdbxweb;

/** Fixed instants, so nothing in a snapshot moves with the clock. */
const CREATED = new Date("2026-01-02T03:04:05Z");
const MODIFIED = new Date("2026-02-03T04:05:06Z");

type EntrySpec = {
  fields: [string, string][];
  protectedFields?: string[];
  tags?: string[];
  attachments?: string[];
};

type GroupSpec = {
  name: string;
  entries?: EntrySpec[];
  groups?: GroupSpec[];
  recycleBin?: boolean;
};

async function build(root: GroupSpec): Promise<Uint8Array> {
  const credentials = new kdbxweb.Credentials(
    kdbxweb.ProtectedValue.fromString(PASSWORD),
  );
  const db = kdbxweb.Kdbx.create(credentials, root.name);
  // The smallest work factor kdbxweb will accept: these snapshots are about
  // the mapping, and nobody should wait on a key derivation to read one.
  db.header.kdfParameters?.set(
    "M",
    kdbxweb.VarDictionary.ValueType.UInt64,
    new kdbxweb.Int64(1024 * 1024 * 4),
  );
  db.header.kdfParameters?.set(
    "I",
    kdbxweb.VarDictionary.ValueType.UInt64,
    new kdbxweb.Int64(1),
  );

  const fill = (group: InstanceType<Kdbxweb["KdbxGroup"]>, spec: GroupSpec) => {
    group.times.creationTime = CREATED;
    group.times.lastModTime = CREATED;
    for (const entry of spec.entries ?? []) {
      const created = db.createEntry(group);
      for (const [key, value] of entry.fields) {
        created.fields.set(
          key,
          entry.protectedFields?.includes(key) === true
            ? kdbxweb.ProtectedValue.fromString(value)
            : value,
        );
      }
      created.tags = entry.tags ?? [];
      for (const name of entry.attachments ?? []) {
        created.binaries.set(name, new Uint8Array([1, 2, 3]));
      }
      created.times.creationTime = CREATED;
      created.times.lastModTime = MODIFIED;
    }
    for (const child of spec.groups ?? []) {
      const made = db.createGroup(group, child.name);
      if (child.recycleBin === true) db.meta.recycleBinUuid = made.uuid;
      fill(made, child);
    }
  };
  fill(db.getDefaultGroup(), root);

  return new Uint8Array(await db.save());
}

async function parse(bytes: Uint8Array): Promise<ParseResult> {
  return keepassKdbx.parse({
    fileName: "snapshot.kdbx",
    text: "",
    headers: null,
    json: null,
    bytes,
    password: PASSWORD,
  });
}

beforeAll(async () => {
  kdbxweb = await import("kdbxweb");
  // Writing a database needs the same Argon2 the adapter installs for
  // reading one; the adapter only does so inside `parse()`, which has not run
  // yet when these fixtures are built.
  const { argon2d, argon2id } = await import("hash-wasm");
  kdbxweb.CryptoEngine.setArgon2Impl(
    async (password, salt, memory, iterations, length, parallelism, type) => {
      const argon2 =
        type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d;
      const hash = await argon2({
        password: new Uint8Array(password),
        salt: new Uint8Array(salt),
        parallelism,
        iterations,
        memorySize: memory,
        hashLength: length,
        outputType: "binary",
      });
      return new Uint8Array(hash).buffer;
    },
  );
}, 30_000);

describe("what a KeePass database becomes", () => {
  it("maps a database of ordinary logins, groups, and fields", async () => {
    const bytes = await build({
      name: "Snapshot",
      entries: [
        {
          fields: [
            ["Title", "Unfiled Login"],
            ["UserName", "root"],
            ["Password", "top-level"],
          ],
          protectedFields: ["Password"],
        },
      ],
      groups: [
        {
          name: "Work",
          entries: [
            {
              fields: [
                ["Title", "Payroll"],
                ["UserName", "ada@example.com"],
                ["Password", "payroll-secret"],
                ["URL", "https://payroll.example.com"],
                ["Notes", "Two\nlines"],
                ["Employee Number", "0042"],
                ["Recovery Token", "rt-9999"],
              ],
              protectedFields: ["Password", "Recovery Token"],
              tags: ["finance", "quarterly"],
            },
          ],
          groups: [
            {
              name: "Vendors",
              entries: [
                {
                  fields: [
                    ["Title", "Courier"],
                    ["UserName", "dispatch"],
                    ["Password", "parcel"],
                  ],
                  protectedFields: ["Password"],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(await parse(bytes)).toMatchSnapshot();
  }, 60_000);

  it("maps every shape of TOTP a KeePass entry can carry", async () => {
    const bytes = await build({
      name: "Snapshot",
      entries: [
        {
          // KeePassXC: a complete URI in the `otp` field, kept verbatim.
          fields: [
            ["Title", "URI form"],
            ["Password", "a"],
            [
              "otp",
              "otpauth://totp/Issuer:me?secret=JBSWY3DPEHPK3PXP&issuer=Issuer",
            ],
          ],
        },
        {
          // KeeOtp: a query string rather than a URI.
          fields: [
            ["Title", "Query form"],
            ["Password", "b"],
            ["otp", "key=JBSWY3DPEHPK3PXP&size=6&step=30"],
          ],
        },
        {
          // KeePassXC's own attributes, at their defaults.
          fields: [
            ["Title", "TimeOtp defaults"],
            ["Password", "c"],
            ["TimeOtp-Secret-Base32", "JBSWY3DPEHPK3PXP"],
          ],
        },
        {
          // …and away from them, including its `HMAC-SHA-512` spelling.
          fields: [
            ["Title", "TimeOtp tuned"],
            ["Password", "d"],
            ["TimeOtp-Secret-Base32", "JBSWY3DPEHPK3PXP"],
            ["TimeOtp-Length", "8"],
            ["TimeOtp-Period", "45"],
            ["TimeOtp-Algorithm", "HMAC-SHA-512"],
          ],
        },
        {
          // Nonsense in the field is not a TOTP and must not become one.
          fields: [
            ["Title", "Not a TOTP"],
            ["Password", "e"],
            ["otp", "ask Bob"],
          ],
        },
      ],
    });
    expect(await parse(bytes)).toMatchSnapshot();
  }, 60_000);

  it("maps the corners: collisions, empty titles, separators, and the bin", async () => {
    const bytes = await build({
      name: "Snapshot",
      groups: [
        {
          name: "Same/Group",
          entries: [
            {
              fields: [
                ["Title", "Twin"],
                ["Password", "1"],
              ],
            },
            {
              fields: [
                ["Title", "Twin"],
                ["Password", "2"],
              ],
            },
            {
              fields: [
                ["Title", "Twin"],
                ["Password", "3"],
              ],
            },
            {
              fields: [
                ["Title", ""],
                ["Password", "nameless"],
              ],
            },
            { fields: [["Password", "no title field at all"]] },
          ],
        },
        {
          name: "Recycle Bin",
          recycleBin: true,
          entries: [
            {
              fields: [
                ["Title", "Deleted"],
                ["Password", "gone"],
              ],
            },
          ],
        },
      ],
    });
    expect(await parse(bytes)).toMatchSnapshot();
  }, 60_000);

  it("maps a KeePassXC passkey and reports what it left behind", async () => {
    const bytes = await build({
      name: "Snapshot",
      entries: [
        {
          fields: [
            ["Title", "example.org"],
            ["UserName", "ada@example.org"],
            ["KPEX_PASSKEY_RELYING_PARTY", "example.org"],
            ["KPEX_PASSKEY_USERNAME", "ada@example.org"],
            ["KPEX_PASSKEY_CREDENTIAL_ID", "Y3JlZC1pZC0wMDE"],
            ["KPEX_PASSKEY_PRIVATE_KEY_PEM", "-----BEGIN PRIVATE KEY-----"],
          ],
          protectedFields: ["KPEX_PASSKEY_PRIVATE_KEY_PEM"],
        },
        {
          // A passkey entry with nothing to identify the credential by.
          fields: [
            ["Title", "Half a passkey"],
            ["KPEX_PASSKEY_USERNAME", "ada@example.org"],
          ],
        },
        {
          fields: [
            ["Title", "Has an attachment"],
            ["Password", "with a file"],
          ],
          attachments: ["recovery-codes.txt"],
        },
      ],
    });
    expect(await parse(bytes)).toMatchSnapshot();
  }, 60_000);
});

describe("the shared cross-implementation fixture", () => {
  /**
   * The fixture is regenerated by `crates/kdbx-bridge`, which stamps the
   * entries with the wall clock of whenever that happened. Everything else in
   * the mapping is fixed, so the timestamps are redacted rather than allowed
   * to make this snapshot fail on a rebuild that changed nothing.
   */
  function redactTimes(result: ParseResult): ParseResult {
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        createdAt: item.createdAt === null ? null : "<timestamp>",
        updatedAt: item.updatedAt === null ? null : "<timestamp>",
      })),
    };
  }

  it("maps the Rust-written database to a stable result", async () => {
    const path = fileURLToPath(
      new URL(
        "../../../../../../../fixtures/kdbx/roundtrip.kdbx",
        import.meta.url,
      ),
    );
    const result = await keepassKdbx.parse({
      fileName: "roundtrip.kdbx",
      text: "",
      headers: null,
      json: null,
      bytes: new Uint8Array(readFileSync(path)),
      password: "correct horse battery staple",
    });
    expect(redactTimes(result)).toMatchSnapshot();
  }, 60_000);
});
