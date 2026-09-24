import {
  type JsonObject,
  type JsonValue,
  overlapCast,
  readJsonObject,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import cases from "../../../spec/conformance/item-type-cases.json" with {
  type: "json",
};
import { builtinRegistry } from "./builtin.js";
import {
  type NativeEntry,
  fromNativeEntry,
  renderNativeEntry,
  toNativeEntry,
} from "./native.js";
import type { FieldValues, ItemTypeDefinition } from "./schema.js";
import {
  type DefinitionErrorCode,
  type DefinitionTrust,
  parseDefinition,
} from "./validate.js";

// ADR 0087 §8 and ADR 0139: the rejection table and the native-projection
// cases crates/vault-item-types runs too (tests/conformance.rs).

type DefinitionCase = {
  readonly name: string;
  readonly set: readonly (readonly [string, JsonValue])[];
  readonly trust?: DefinitionTrust;
  readonly codes?: readonly DefinitionErrorCode[];
  readonly codesAnyOf?: readonly DefinitionErrorCode[];
  readonly valid?: true;
};

type ProjectionCase = {
  readonly name: string;
  readonly type: string;
  readonly values?: FieldValues;
  readonly entry: NativeEntry;
  readonly rendered?: string;
  readonly readback?: {
    readonly values: FieldValues;
    readonly extra?: Readonly<Record<string, string>>;
  };
};

type Cases = {
  readonly draft: JsonObject;
  readonly definitionCases: readonly DefinitionCase[];
  readonly projectionCases: readonly ProjectionCase[];
};

const shared: Cases = overlapCast(JSON.parse(JSON.stringify(cases)));

/**
 * Write `value` at a JSON Pointer (RFC 6901), creating a missing object key;
 * a final `-` appends to an array.
 */
function setPointer(target: JsonObject, pointer: string, value: JsonValue) {
  const tokens = pointer
    .split("/")
    .slice(1)
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  const last = tokens.pop();
  if (last === undefined) throw new Error(`${pointer} names no location`);
  let node: JsonValue = target;
  for (const token of tokens) {
    const next: JsonValue | undefined = Array.isArray(node)
      ? node[Number(token)]
      : readJsonObject(node)?.[token];
    if (next === undefined) throw new Error(`${pointer} walks past ${token}`);
    node = next;
  }
  if (Array.isArray(node)) {
    if (last === "-") node.push(value);
    else node[Number(last)] = value;
    return;
  }
  const parent = readJsonObject(node);
  if (parent === undefined) throw new Error(`${pointer} ends in a scalar`);
  parent[last] = value;
}

function refusedCodes(c: DefinitionCase): DefinitionErrorCode[] {
  const draft: JsonObject = overlapCast(
    JSON.parse(JSON.stringify(shared.draft)),
  );
  for (const [pointer, value] of c.set) setPointer(draft, pointer, value);
  const result = parseDefinition(JSON.stringify(draft), c.trust ?? "community");
  return result.ok ? [] : result.errors.map((error) => error.code);
}

describe("item-type conformance: definitions", () => {
  for (const c of shared.definitionCases) {
    it(c.name, () => {
      const stated = [c.codes, c.codesAnyOf, c.valid].filter(
        (expectation) => expectation !== undefined,
      );
      expect(stated).toHaveLength(1);
      const refused = refusedCodes(c);
      if (c.valid === true) expect(refused).toEqual([]);
      for (const code of c.codes ?? []) expect(refused).toContain(code);
      if (c.codesAnyOf !== undefined)
        expect(c.codesAnyOf.some((code) => refused.includes(code))).toBe(true);
    });
  }
});

const registry = builtinRegistry();

function definition(id: string): ItemTypeDefinition {
  const found = registry.get(id);
  if (found === undefined) throw new Error(`no built-in type ${id}`);
  return found;
}

function entryFor(c: ProjectionCase, type: ItemTypeDefinition): NativeEntry {
  if (c.values === undefined) return c.entry;
  const entry = toNativeEntry(type, c.values);
  expect(entry).toEqual({ secret: c.entry.secret, trailer: c.entry.trailer });
  if (c.rendered !== undefined)
    expect(renderNativeEntry(entry)).toBe(c.rendered);
  return entry;
}

describe("item-type conformance: native projection", () => {
  for (const c of shared.projectionCases) {
    it(c.name, () => {
      const type = definition(c.type);
      const entry = entryFor(c, type);
      if (c.readback === undefined) return;
      const back = fromNativeEntry(type, entry);
      expect(back.values).toEqual(c.readback.values);
      if (c.readback.extra !== undefined)
        expect(back.extra).toEqual(c.readback.extra);
    });
  }
});
