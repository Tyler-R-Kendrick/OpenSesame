/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { SopsError } from "./errors.js";
import { parseJsonTree } from "./json-codec.js";
import { entry, scalarText } from "./model.js";
import {
  NEVER,
  TestSession,
  newIdentities,
  newIdentity,
} from "./test-support.js";
import { parseYamlDocuments } from "./yaml-parse.js";

const NOW = new Date("2026-09-21T12:00:00Z");

async function opened(
  session: TestSession,
  text: string,
  format: "yaml" | "json",
  identities: string[],
) {
  return session.engine.open(text, format, {
    identities,
    permit: session.permit(),
    signal: NEVER,
  });
}

describe("browser SOPS engine (local age)", () => {
  it("round-trips YAML with comments, typed scalars, and the default suffix (SB-007, SB-013)", async () => {
    const session = new TestSession();
    const id = await newIdentity();
    const plain =
      '# head\nhello: world # inline\ncount: 2\nratio: 1.5\nflag: true\nwhen: 2001-12-14T21:59:43.1Z\nempty: ""\nnothing: null\nnote_unencrypted: visible\nlist:\n  # before\n  - a\n  - 3\nnested:\n  k: v\n';
    const { plan, permit } = await session.plan("yaml", [[id.recipient]]);
    const cipher = await session.engine.encryptNew(plain, {
      plan,
      permit,
      signal: NEVER,
      now: NOW,
    });
    expect(cipher).toMatch(/ENC\[AES256_GCM,/u);
    expect(cipher).toMatch(/note_unencrypted: visible/u);
    expect(cipher).toMatch(/type:int\]/u);
    expect(cipher).toMatch(/type:float\]/u);
    expect(cipher).toMatch(/type:bool\]/u);
    expect(cipher).toMatch(/type:time\]/u);
    expect(cipher).toMatch(/#ENC\[AES256_GCM,[^\]]*type:comment\]/u);
    expect(cipher).toMatch(/lastmodified: "2026-09-21T12:00:00Z"/u);
    expect(cipher).toMatch(/version: 3\.13\.3/u);
    expect(cipher).not.toMatch(/world|visible2/u);
    const result = await opened(session, cipher, "yaml", [id.identity]);
    expect(parseYamlDocuments(result.plaintext)).toEqual(
      parseYamlDocuments(plain),
    );
    expect(result.inspection.encrypted).toBe(true);
    expect(result.report.openedGroups).toBe(1);
  });

  it("round-trips JSON with ordered numeric keys and exact integers (SB-008, SB-009)", async () => {
    const session = new TestSession();
    const id = await newIdentity();
    const plain =
      '{"10":"a","2":"b","01":"c","__proto__":"d","big":9223372036854775807,"neg":-0,"f":1.0,"arr":[1,{"x":null}],"e":{}}';
    const { plan, permit } = await session.plan("json", [[id.recipient]]);
    const cipher = await session.engine.encryptNew(plain, {
      plan,
      permit,
      signal: NEVER,
      now: NOW,
    });
    expect(cipher.indexOf('"10"')).toBeLessThan(cipher.indexOf('"2"'));
    const result = await opened(session, cipher, "json", [id.identity]);
    expect(parseJsonTree(result.plaintext)).toEqual(
      parseJsonTree(
        '{"10":"a","2":"b","01":"c","__proto__":"d","big":9223372036854775807,"neg":0,"f":1.0,"arr":[1,{"x":null}],"e":{}}',
      ),
    );
    expect(result.plaintext).toMatch(/9223372036854775807/u);
  });

  it("refuses a wrong identity, a tampered value, a swapped value, and a changed timestamp (SB-022, SB-023, SB-024)", async () => {
    const session = new TestSession();
    const id = await newIdentity();
    const other = await newIdentity();
    const { plan, permit } = await session.plan("yaml", [[id.recipient]]);
    const cipher = await session.engine.encryptNew("a: one\nb: two\n", {
      plan,
      permit,
      signal: NEVER,
      now: NOW,
    });
    await expect(
      opened(session, cipher, "yaml", [other.identity]),
    ).rejects.toMatchObject({ code: "missing_identity" });
    const values = [...cipher.matchAll(/^(a|b): (ENC\[[^\]]+\])$/gmu)].map(
      (match) => match[2] ?? "",
    );
    const swapped = cipher
      .replace(`a: ${values[0]}`, `a: ${values[1]}`)
      .replace(`b: ${values[1]}`, `b: ${values[0]}`);
    await expect(
      opened(session, swapped, "yaml", [id.identity]),
    ).rejects.toMatchObject({ code: "authentication_failed" });
    const tampered = cipher.replace(
      /(a: ENC\[AES256_GCM,data:)([^,]+)/u,
      (_, head: string, data: string) =>
        `${head}${data.slice(0, -1)}${data.endsWith("A") ? "B" : "A"}`,
    );
    await expect(
      opened(session, tampered, "yaml", [id.identity]),
    ).rejects.toMatchObject({ code: "authentication_failed" });
    const retimed = cipher.replace(
      'lastmodified: "2026-09-21T12:00:00Z"',
      'lastmodified: "2026-09-21T12:00:01Z"',
    );
    await expect(
      opened(session, retimed, "yaml", [id.identity]),
    ).rejects.toMatchObject({ code: "authentication_failed" });
    const noMac = cipher.replace(/mac: ENC\[[^\]]+\]/u, 'mac: ""');
    await expect(
      opened(session, noMac, "yaml", [id.identity]),
    ).rejects.toMatchObject({ code: "authentication_failed" });
  });

  it("detects a moved clear value under the default MAC but not under mac_only_encrypted (SB-025, SB-026)", async () => {
    const session = new TestSession();
    const id = await newIdentity();
    const plain = "secret: s\npublic_unencrypted: p\n";
    const full = await session.plan("yaml", [[id.recipient]]);
    const cipher = await session.engine.encryptNew(plain, {
      plan: full.plan,
      permit: full.permit,
      signal: NEVER,
      now: NOW,
    });
    await expect(
      opened(
        session,
        cipher.replace("public_unencrypted: p", "public_unencrypted: q"),
        "yaml",
        [id.identity],
      ),
    ).rejects.toMatchObject({ code: "authentication_failed" });
    const partial = await session.plan("yaml", [[id.recipient]], {
      policy: { macOnlyEncrypted: true },
    });
    const cipher2 = await session.engine.encryptNew(plain, {
      plan: partial.plan,
      permit: partial.permit,
      signal: NEVER,
      now: NOW,
    });
    expect(cipher2).toMatch(/mac_only_encrypted: true/u);
    const result = await opened(
      session,
      cipher2.replace("public_unencrypted: p", "public_unencrypted: q"),
      "yaml",
      [id.identity],
    );
    expect(result.plaintext).toMatch(/public_unencrypted: q/u);
    expect(result.inspection.integrityMode).toBe("encrypted-values-only");
  });

  it("binds an approval to the exact plan and refuses stale sessions (SB-049, SB-061)", async () => {
    const session = new TestSession();
    const id = await newIdentity();
    const other = await newIdentity();
    const { plan, permit } = await session.plan("yaml", [[id.recipient]]);
    const swapped = {
      ...plan,
      groups: [[{ kind: "age" as const, recipient: other.recipient }]],
    };
    await expect(
      session.engine.encryptNew("a: 1\n", {
        plan: swapped,
        permit,
        signal: NEVER,
      }),
    ).rejects.toMatchObject({ code: "unauthorized_policy" });
    const cipher = await session.engine.encryptNew("a: 1\n", {
      plan,
      permit,
      signal: NEVER,
    });
    const result = await opened(session, cipher, "yaml", [id.identity]);
    const stalePermit = session.permit();
    session.generation += 1;
    expect(() => session.engine.plaintext(result.handle, stalePermit)).toThrow(
      SopsError,
    );
    await expect(
      session.engine.saveEdited(
        result.handle,
        "a: 2\n",
        session.permit(),
        NEVER,
      ),
    ).rejects.toMatchObject({ code: "stale_session" });
    const wrongVault = session.permit("", "other-vault");
    await expect(
      opened(session, cipher, "yaml", [id.identity]).then((r) =>
        session.engine.plaintext(r.handle, wrongVault),
      ),
    ).rejects.toMatchObject({ code: "stale_session" });
  });

  it("inspection is inert and reports groups without opening anything (SB-050)", async () => {
    const session = new TestSession();
    const id = await newIdentity();
    const { plan, permit } = await session.plan("json", [[id.recipient]]);
    const cipher = await session.engine.encryptNew('{"k":"v"}', {
      plan,
      permit,
      signal: NEVER,
    });
    const inspection = session.engine.inspect(cipher, "json");
    expect(inspection).toMatchObject({
      encrypted: true,
      version: "3.13.3",
      requiredGroups: 1,
    });
    expect(inspection.keyGroups[0]?.entries[0]).toMatchObject({
      kind: "age",
      locator: id.recipient,
      browserOpenable: true,
    });
    expect(session.engine.inspect('{"k":"v"}', "json").encrypted).toBe(false);
    expect(() => session.engine.inspect("- a\n", "yaml")).toThrow(SopsError);
  });

  it("refuses reserved keys, duplicate metadata, and out-of-profile syntax before any key work (SB-016, SB-017, SB-018)", async () => {
    const session = new TestSession();
    const id = await newIdentity();
    const { plan, permit } = await session.plan("yaml", [[id.recipient]]);
    await expect(
      session.engine.encryptNew("sops: {x: 1}\na: 1\n", {
        plan,
        permit,
        signal: NEVER,
      }),
    ).rejects.toMatchObject({ code: "invalid_document" });
    await expect(
      session.engine.encryptNew("a: 1\na: 2\n", {
        plan,
        permit,
        signal: NEVER,
      }),
    ).rejects.toMatchObject({ code: "duplicate_key" });
    await expect(
      session.engine.encryptNew("a: &x 1\nb: *x\n", {
        plan,
        permit,
        signal: NEVER,
      }),
    ).rejects.toMatchObject({ code: "unsupported_feature" });
    await expect(
      session.engine.encryptNew("1: x\n", { plan, permit, signal: NEVER }),
    ).rejects.toMatchObject({ code: "unsupported_feature" });
    const cipher = await session.engine.encryptNew("a: 1\n---\nb: 2\n", {
      plan,
      permit,
      signal: NEVER,
    });
    expect(cipher.match(/^---$/gmu)?.length).toBe(1);
    const conflicting = cipher.replace(
      /version: 3\.13\.3\n$/u,
      "version: 3.13.2\n",
    );
    expect(conflicting).not.toBe(cipher);
    await expect(
      opened(session, conflicting, "yaml", [id.identity]),
    ).rejects.toMatchObject({ code: "invalid_metadata" });
    const result = await opened(session, cipher, "yaml", [id.identity]);
    expect(result.plaintext).toBe("a: 1\n---\nb: 2\n");
    const bothSelectors = cipher.replace(
      "\n  unencrypted_suffix: _unencrypted\n",
      "\n  unencrypted_suffix: _unencrypted\n  encrypted_regex: ^a$\n",
    );
    expect(bothSelectors).not.toBe(cipher);
    await expect(
      opened(session, bothSelectors, "yaml", [id.identity]),
    ).rejects.toMatchObject({ code: "invalid_metadata" });
  });

  it("encrypted comment selectors and regex selectors follow the comments stack (SB-045, SB-046, SB-047)", async () => {
    const session = new TestSession();
    const id = await newIdentity();
    const plain =
      "# sops:enc\nsecret_a: one\n# plain\npublic_b: two\nnested:\n  # sops:enc\n  inner: three\n  other: four\nlist:\n  # sops:enc\n  - five\n  - six\n";
    const { plan, permit } = await session.plan("yaml", [[id.recipient]], {
      policy: { unencryptedSuffix: "", encryptedCommentRegex: "sops:enc" },
    });
    const cipher = await session.engine.encryptNew(plain, {
      plan,
      permit,
      signal: NEVER,
      now: NOW,
    });
    expect(cipher).toMatch(/^# sops:enc\nsecret_a: ENC\[/u);
    expect(cipher).toMatch(/public_b: two/u);
    expect(cipher).toMatch(/other: four/u);
    expect(cipher).toMatch(/- six/u);
    expect(cipher).toMatch(/ {2}- ENC\[/u);
    const result = await opened(session, cipher, "yaml", [id.identity]);
    expect(result.plaintext).toBe(plain);
    // A pattern that would hang a backtracking engine is answered, not refused.
    await expect(
      session.plan("yaml", [[id.recipient]], {
        policy: { unencryptedSuffix: "", encryptedRegex: "(a+)+$" },
      }),
    ).resolves.toBeTruthy();
    // Valid RE2 this engine does not implement is refused, never reinterpreted.
    await expect(
      session.plan("yaml", [[id.recipient]], {
        policy: { unencryptedSuffix: "", encryptedRegex: "(?i)a" },
      }),
    ).rejects.toMatchObject({ code: "unsupported_feature" });
    await expect(
      session.plan("yaml", [[id.recipient]], {
        policy: { unencryptedSuffix: "", encryptedRegex: "(?=a)" },
      }),
    ).rejects.toMatchObject({ code: "unsupported_feature" });
    const regex = await session.plan("json", [[id.recipient]], {
      policy: { unencryptedSuffix: "", encryptedRegex: "^(pw|token)$" },
    });
    const json = await session.engine.encryptNew(
      '{"pw":"x","name":"n","o":{"token":"t","x":1}}',
      { plan: regex.plan, permit: regex.permit, signal: NEVER },
    );
    expect(json).toMatch(/"name": "n"/u);
    expect(json).toMatch(/"x": 1/u);
    expect(json).not.toMatch(/"pw": "x"/u);
    const root = parseJsonTree(
      (await opened(session, json, "json", [id.identity])).plaintext,
    );
    expect(scalarText(entry(entry(root, "o") ?? root, "token"))).toBe("t");
  });
});
