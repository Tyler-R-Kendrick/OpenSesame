import { describe, expect, it } from "vitest";
import { builtinRegistry } from "./builtin.js";
import {
  decodeValue,
  encodeValue,
  fromNativeEntry,
  renderNativeEntry,
  toNativeEntry,
} from "./native.js";
import type { FieldValues, ItemTypeDefinition } from "./schema.js";
import { parseDefinition } from "./validate.js";

const registry = builtinRegistry();

function definition(id: string): ItemTypeDefinition {
  const found = registry.get(id);
  if (found === undefined) throw new Error(`no built-in type ${id}`);
  return found;
}

describe("the base native secret projection", () => {
  it("puts the declared field on line one and the rest in the trailer", () => {
    const login = definition("login");
    const entry = toNativeEntry(login, {
      username: "ada",
      password: "correct horse",
      totp: "",
      uris: ["https://example.test"],
    });
    expect(entry.secret).toBe("correct horse");
    expect(entry.trailer).toBe("login: ada\nurl: https://example.test\n");
    expect(renderNativeEntry(entry)).toBe(
      "correct horse\nlogin: ada\nurl: https://example.test\n",
    );
  });

  it("round-trips values through the entry", () => {
    const bank = definition("bank-account");
    const values: FieldValues = {
      bank: "Example Savings",
      accountHolder: { first: "Ada", middle: "", last: "Lovelace" },
      accountType: "checking",
      accountNumber: "0001234567",
      routingNumber: "110000000",
      iban: "",
      swift: "EXMPGB2L",
      pin: "4321",
      branchPhone: "+44 20 7946 0000",
      branchAddress: {
        street1: "1 Example Street",
        street2: "",
        city: "London",
        state: "",
        postalCode: "EC1A 1AA",
        country: "GB",
      },
      onlineBanking: "https://bank.example.test",
    };
    const back = fromNativeEntry(bank, toNativeEntry(bank, values));
    expect(back.values.bank).toBe("Example Savings");
    expect(back.values.accountNumber).toBe("0001234567");
    expect(back.values.pin).toBe("4321");
    expect(back.values.accountHolder).toEqual({
      first: "Ada",
      last: "Lovelace",
    });
    expect(back.values.branchAddress).toEqual({
      street1: "1 Example Street",
      city: "London",
      postalCode: "EC1A 1AA",
      country: "GB",
    });
    expect(back.extra).toEqual({});
  });

  it("projects a type with no secret to an empty first line", () => {
    const note = definition("note");
    const entry = toNativeEntry(note, { notes: "remember the milk" });
    expect(entry.secret).toBe("");
    expect(entry.trailer).toBe("notes: remember the milk\n");
    expect(fromNativeEntry(note, entry).values.notes).toBe("remember the milk");
  });

  it("keeps a multi-line value on one trailer line", () => {
    const note = definition("note");
    const entry = toNativeEntry(note, { notes: "first\nsecond\\third" });
    expect(
      entry.trailer.split("\n").filter((line) => line !== ""),
    ).toHaveLength(1);
    expect(fromNativeEntry(note, entry).values.notes).toBe(
      "first\nsecond\\third",
    );
  });

  it("never lets a value break line one", () => {
    const secret = definition("secret");
    const entry = toNativeEntry(secret, {
      value: "a\nb",
      connectionRef: "",
      grantees: [],
    });
    expect(entry.secret).not.toContain("\n");
    expect(fromNativeEntry(secret, entry).values.value).toBe("a\nb");
  });

  it("writes a TOTP seed as a bare otpauth line so pass-otp finds it", () => {
    const login = definition("login");
    const uri = "otpauth://totp/Demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // gitleaks:allow -- RFC fixture
    const entry = toNativeEntry(login, {
      username: "ada",
      password: "pw",
      totp: uri,
      uris: [],
    });
    expect(entry.trailer).toContain(`\n${uri}\n`);
    expect(fromNativeEntry(login, entry).values.totp).toBe(uri);
  });

  it("repeats a key for each value of a repeating field", () => {
    const login = definition("login");
    const entry = toNativeEntry(login, {
      username: "",
      password: "",
      totp: "",
      uris: ["https://a.test", "https://b.test"],
    });
    expect(entry.trailer).toBe("url: https://a.test\nurl: https://b.test\n");
    expect(fromNativeEntry(login, entry).values.uris).toEqual([
      "https://a.test",
      "https://b.test",
    ]);
  });

  it("keeps trailer keys the definition does not claim", () => {
    const note = definition("note");
    const back = fromNativeEntry(note, {
      secret: "",
      trailer: "notes: hello\nlegacy_key: kept\n",
    });
    expect(back.values.notes).toBe("hello");
    expect(back.extra).toEqual({ legacy_key: "kept" });
  });

  it("is stable across a second round trip for every built-in type", () => {
    for (const { definition: def } of registry.list()) {
      const values: Record<string, string> = {};
      for (const section of def.spec.sections) {
        for (const field of section.fields) {
          if (field.multiple === true) continue;
          values[field.id] = `v-${field.id}`;
        }
      }
      const once = toNativeEntry(def, values);
      const back = fromNativeEntry(def, once);
      const twice = toNativeEntry(def, back.values);
      expect(twice).toEqual(once);
    }
  });
});

describe("value escaping", () => {
  it("is an exact inverse", () => {
    for (const sample of [
      "",
      "plain",
      "a\nb",
      "a\\nb",
      "\\",
      "\r\n",
      "a\\\\b",
    ]) {
      expect(decodeValue(encodeValue(sample))).toBe(sample);
    }
  });

  it("leaves an unrecognised escape alone", () => {
    expect(decodeValue("a\\qb")).toBe("a\\qb");
  });
});

describe("the community path", () => {
  it("makes a freshly authored type readable as a pass entry", () => {
    const authored = JSON.stringify({
      apiVersion: "opensesame.dev/v1alpha1",
      kind: "VaultItemType",
      metadata: {
        id: "resident-id",
        version: "1.0.0",
        publisher: "https://community.test",
      },
      spec: {
        title: "Resident ID",
        plural: "Resident IDs",
        extension: ".rid",
        summary: "A national residence permit.",
        categories: ["identity"],
        sections: [
          {
            id: "card",
            title: "Card",
            fields: [
              {
                id: "country",
                type: "country",
                label: "Country",
                required: true,
              },
              { id: "permitNumber", type: "concealed", label: "Permit number" },
              { id: "expiresAt", type: "date", label: "Expires" },
            ],
          },
        ],
        native: {
          secret: "permitNumber",
          trailer: [
            { key: "country", field: "country" },
            { key: "expires_at", field: "expiresAt" },
          ],
        },
        cxf: { credential: "identity-document" },
        subtitle: ["country", "expiresAt"],
        search: ["country"],
      },
    });
    const parsed = parseDefinition(authored, "community");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const entry = toNativeEntry(parsed.definition, {
      country: "NL",
      permitNumber: "Z1234567",
      expiresAt: "2030-01-01",
    });
    expect(renderNativeEntry(entry)).toBe(
      "Z1234567\ncountry: NL\nexpires_at: 2030-01-01\n",
    );
  });
});

describe("parity with the host-plane parser", () => {
  it("keeps an unclaimed trailer key that carries a dot", () => {
    const note = definition("note");
    // `crates/vault-item-types` keeps this line; a regex that also constrained
    // the part used to drop it here, so the two planes disagreed about what
    // survives a readback.
    const back = fromNativeEntry(note, {
      secret: "",
      trailer: "notes: hello\nlegacy.sub.key: kept\n",
    });
    expect(back.values.notes).toBe("hello");
    expect(back.extra["legacy.sub.key"]).toBe("kept");
  });

  it("keeps a key whose part is empty", () => {
    const note = definition("note");
    const back = fromNativeEntry(note, {
      secret: "",
      trailer: "odd.: kept\n",
    });
    expect(back.extra["odd."]).toBe("kept");
  });

  it("drops a line whose key is not a slug, on both planes", () => {
    const note = definition("note");
    const back = fromNativeEntry(note, {
      secret: "",
      trailer: "Notes: shouted\n",
    });
    expect(back.extra).toEqual({});
  });
});

describe("what a projection deliberately withholds", () => {
  it("never writes a drop's bearer token into an entry", () => {
    const drop = definition("drop");
    const entry = toNativeEntry(drop, {
      state: "pending",
      claimId: "clm_1",
      bearerToken: "bearer-secret-value",
      expiresAt: "2030-01-01",
    });
    // A drop's payload lives in its claim, not the vault, and the store has
    // always withheld the token that polls it. The definition agrees.
    expect(renderNativeEntry(entry)).not.toContain("bearer-secret-value");
    expect(entry.secret).toBe("");
  });
});
