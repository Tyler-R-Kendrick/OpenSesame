import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import cases from "../../../spec/conformance/item-type-cases.json" with {
  type: "json",
};
import { FIELD_TYPES, FIELD_TYPE_IDS } from "./catalogue.js";
import { type DefinitionErrorCode, parseDefinition } from "./validate.js";

/**
 * What the shared rejection table cannot say as a row. The table itself —
 * every rule ADR 0087 §5 states — is `spec/conformance/item-type-cases.json`,
 * run here by `conformance.test.ts` and on the host plane by
 * `crates/vault-item-types/tests/conformance.rs` (ADR 0139).
 */

function draft(): JsonObject {
  return overlapCast(JSON.parse(JSON.stringify(cases.draft)));
}

type Parsed = ReturnType<typeof parseDefinition>;

function codes(result: Parsed): DefinitionErrorCode[] {
  return result.ok ? [] : result.errors.map((error) => error.code);
}

describe("parseDefinition", () => {
  it("refuses a document larger than the cap", () => {
    const large = draft();
    const spec: JsonObject = overlapCast(large.spec);
    spec.summary = "x".repeat(80 * 1024);
    const result = parseDefinition(JSON.stringify(large), "community");
    expect(codes(result)).toEqual(["too-large"]);
  });

  it("refuses malformed JSON", () => {
    expect(codes(parseDefinition("{", "community"))).toEqual(["syntax"]);
  });

  it("has no schema field that could carry a URL a loader would fetch", () => {
    const result = parseDefinition(JSON.stringify(draft()), "community");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialised = JSON.stringify(result.definition);
    for (const smell of [
      "component",
      "oci",
      "src",
      "href",
      "endpoint",
      "script",
    ]) {
      expect(serialised).not.toContain(`"${smell}"`);
    }
  });
});

describe("the field-type catalogue", () => {
  it("lists exactly the entries in the table", () => {
    expect([...FIELD_TYPE_IDS].sort()).toEqual(Object.keys(FIELD_TYPES).sort());
  });

  it("marks a record field concealed when any part is", () => {
    expect(FIELD_TYPES["key-pair"].concealed).toBe(true);
    expect(FIELD_TYPES["security-question"].concealed).toBe(true);
    expect(FIELD_TYPES["person-name"].concealed).toBe(false);
  });

  it("gives every record shape at least one part and every scalar none", () => {
    for (const id of FIELD_TYPE_IDS) {
      const entry = FIELD_TYPES[id];
      if (entry.valueKind === "record")
        expect(entry.parts.length).toBeGreaterThan(0);
      else expect(entry.parts).toEqual([]);
    }
  });
});
