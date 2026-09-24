import { describe, expect, it } from "vitest";
import { builtinRegistry } from "./builtin.js";
import {
  decodeValue,
  encodeValue,
  fromNativeEntry,
  renderNativeEntry,
  toNativeEntry,
} from "./native.js";
import { parseDefinition } from "./validate.js";

// The concrete projection cases — what a login, a note, a drop or a bank
// account writes and reads back — are `spec/conformance/item-type-cases.json`,
// run by `conformance.test.ts` and by `crates/vault-item-types` (ADR 0139).
// What stays here is corpus-wide or TypeScript-only.

const registry = builtinRegistry();

describe("the base native secret projection", () => {
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
