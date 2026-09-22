/**
 * Strict field readers over a `BoundaryValue` object.
 *
 * Every reader records the key it consumed; `finish()` turns every key it
 * never saw into an `UNKNOWN_FIELD` diagnostic. Readers return `undefined`
 * on failure and never throw; the caller assembles the document only when
 * every field came back defined and the diagnostic list is empty.
 */
import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import {
  type Diagnostic,
  type DiagnosticCode,
  diagnostic,
  pushDiagnostic,
} from "./diagnostics.js";
import {
  MAX_REVISION_LENGTH,
  isCapabilityId,
  isOpaqueId,
  isUnitName,
} from "./ids.js";

/** Longest list of ids any document may carry. */
export const MAX_LIST_IDS = 256;
/** Longest list of free-form strings (origins, constraints) a document may carry. */
export const MAX_STRING_LIST = 256;
export const MAX_ORIGIN_LENGTH = 256;

export type StringBounds = Readonly<{
  min: number;
  max: number;
  pattern?: RegExp;
  code?: DiagnosticCode;
}>;

export const REVISION_BOUNDS: StringBounds = {
  min: 1,
  max: MAX_REVISION_LENGTH,
};

function joinPath(base: string, key: string): string {
  return base === "" ? key : `${base}.${key}`;
}

export function indexPath(base: string, index: number): string {
  return `${base}[${index}]`;
}

export class ObjectReader {
  private readonly seen = new Set<string>();

  constructor(
    private readonly obj: JsonObject,
    readonly path: string,
    readonly diags: Diagnostic[],
  ) {}

  report(code: DiagnosticCode, path: string, message: string): void {
    pushDiagnostic(this.diags, diagnostic(code, path, message));
  }

  /** Raw access; marks the key consumed. `undefined` when absent (reported). */
  raw(key: string): { value: JsonValue; path: string } | undefined {
    this.seen.add(key);
    const path = joinPath(this.path, key);
    if (!Object.hasOwn(this.obj, key) || this.obj[key] === undefined) {
      this.report("MISSING_FIELD", path, `missing field \`${key}\``);
      return undefined;
    }
    const value = this.obj[key];
    if (value === undefined) return undefined;
    return { value, path };
  }

  literal<T extends string | number>(key: string, expected: T): T | undefined {
    const field = this.raw(key);
    if (field === undefined) return undefined;
    if (field.value !== expected) {
      this.report(
        "INVALID_VALUE",
        field.path,
        `\`${key}\` must be ${JSON.stringify(expected)}`,
      );
      return undefined;
    }
    return expected;
  }

  string(key: string, bounds: StringBounds): string | undefined {
    const field = this.raw(key);
    if (field === undefined) return undefined;
    return checkString(this, field.value, field.path, key, bounds);
  }

  opaqueId(key: string): string | undefined {
    const field = this.raw(key);
    if (field === undefined) return undefined;
    if (!isString(field.value)) {
      this.report("INVALID_TYPE", field.path, `\`${key}\` must be a string`);
      return undefined;
    }
    if (!isOpaqueId(field.value)) {
      this.report(
        "INVALID_ID",
        field.path,
        `\`${key}\` must be 1–128 characters of [A-Za-z0-9._:-]`,
      );
      return undefined;
    }
    return field.value;
  }

  boolean(key: string): boolean | undefined {
    const field = this.raw(key);
    if (field === undefined) return undefined;
    if (!isBoolean(field.value)) {
      this.report("INVALID_TYPE", field.path, `\`${key}\` must be a boolean`);
      return undefined;
    }
    return field.value;
  }

  nonNegativeInteger(key: string, max: number): number | undefined {
    const field = this.raw(key);
    if (field === undefined) return undefined;
    if (!isNumber(field.value) || !Number.isInteger(field.value)) {
      this.report("INVALID_TYPE", field.path, `\`${key}\` must be an integer`);
      return undefined;
    }
    if (field.value < 0 || field.value > max) {
      this.report("INVALID_VALUE", field.path, `\`${key}\` must be 0..${max}`);
      return undefined;
    }
    return field.value;
  }

  enumOf<T extends string>(key: string, allowed: readonly T[]): T | undefined {
    const field = this.raw(key);
    if (field === undefined) return undefined;
    const match = allowed.find((option) => option === field.value);
    if (match === undefined) {
      this.report(
        "INVALID_VALUE",
        field.path,
        `\`${key}\` must be one of ${allowed.map((o) => JSON.stringify(o)).join(", ")}`,
      );
      return undefined;
    }
    return match;
  }

  /** Bounded, duplicate-free list of capability ids. */
  idList(key: string): string[] | undefined {
    const field = this.raw(key);
    if (field === undefined) return undefined;
    return checkIdList(this, field.value, field.path, key);
  }

  /** `null` and `[]` are distinct outcomes and both survive the parse. */
  nullableIdList(key: string): string[] | null | undefined {
    const field = this.raw(key);
    if (field === undefined) return undefined;
    if (field.value === null) return null;
    return checkIdList(this, field.value, field.path, key);
  }

  /** Bounded list of strings, each within `bounds`, duplicate-free. */
  stringList(
    key: string,
    bounds: StringBounds,
    max: number = MAX_STRING_LIST,
  ): string[] | undefined {
    const field = this.raw(key);
    if (field === undefined) return undefined;
    if (!Array.isArray(field.value)) {
      this.report("INVALID_TYPE", field.path, `\`${key}\` must be an array`);
      return undefined;
    }
    if (field.value.length > max) {
      this.report(
        "TOO_MANY_ITEMS",
        field.path,
        `\`${key}\` exceeds ${max} entries`,
      );
      return undefined;
    }
    const out: string[] = [];
    let valid = true;
    field.value.forEach((entry, index) => {
      const path = indexPath(field.path, index);
      const value = checkString(this, entry, path, key, bounds);
      if (value === undefined) {
        valid = false;
        return;
      }
      if (out.includes(value)) {
        this.report("DUPLICATE_ID", path, `duplicate entry in \`${key}\``);
        valid = false;
        return;
      }
      out.push(value);
    });
    return valid ? out : undefined;
  }

  object(key: string): ObjectReader | undefined {
    const field = this.raw(key);
    if (field === undefined) return undefined;
    if (!isJsonObject(field.value)) {
      this.report("INVALID_TYPE", field.path, `\`${key}\` must be an object`);
      return undefined;
    }
    return new ObjectReader(field.value, field.path, this.diags);
  }

  /** An object whose value may be `null`; returns `null` for that case. */
  nullableObject(key: string): ObjectReader | null | undefined {
    const field = this.raw(key);
    if (field === undefined) return undefined;
    if (field.value === null) return null;
    if (!isJsonObject(field.value)) {
      this.report(
        "INVALID_TYPE",
        field.path,
        `\`${key}\` must be an object or null`,
      );
      return undefined;
    }
    return new ObjectReader(field.value, field.path, this.diags);
  }

  /** Bounded record with validated keys and validated string values. */
  record(
    key: string,
    keyCheck: (k: string) => boolean,
    keyMessage: string,
    valueCheck: (v: string) => boolean,
    valueMessage: string,
  ): Record<string, string> | undefined {
    const field = this.raw(key);
    if (field === undefined) return undefined;
    if (!isJsonObject(field.value)) {
      this.report("INVALID_TYPE", field.path, `\`${key}\` must be an object`);
      return undefined;
    }
    const keys = Object.keys(field.value).sort();
    if (keys.length > MAX_LIST_IDS) {
      this.report(
        "TOO_MANY_ITEMS",
        field.path,
        `\`${key}\` exceeds ${MAX_LIST_IDS} entries`,
      );
      return undefined;
    }
    const out: Record<string, string> = {};
    let valid = true;
    for (const entryKey of keys) {
      const path = joinPath(field.path, entryKey);
      const value = field.value[entryKey];
      if (!keyCheck(entryKey)) {
        this.report("INVALID_ID", path, keyMessage);
        valid = false;
      } else if (!isString(value)) {
        this.report(
          "INVALID_TYPE",
          path,
          `entry in \`${key}\` must be a string`,
        );
        valid = false;
      } else if (!valueCheck(value)) {
        this.report("INVALID_VALUE", path, valueMessage);
        valid = false;
      } else {
        out[entryKey] = value;
      }
    }
    return valid ? out : undefined;
  }

  /** Bounded array of objects, each read through its own indexed reader. */
  objectList(key: string, max: number): ObjectReader[] | undefined {
    const field = this.raw(key);
    if (field === undefined) return undefined;
    if (!Array.isArray(field.value)) {
      this.report("INVALID_TYPE", field.path, `\`${key}\` must be an array`);
      return undefined;
    }
    if (field.value.length > max) {
      this.report(
        "TOO_MANY_ITEMS",
        field.path,
        `\`${key}\` exceeds ${max} entries`,
      );
      return undefined;
    }
    const out: ObjectReader[] = [];
    let valid = true;
    field.value.forEach((entry, index) => {
      const path = indexPath(field.path, index);
      if (!isJsonObject(entry)) {
        this.report(
          "INVALID_TYPE",
          path,
          `entry in \`${key}\` must be an object`,
        );
        valid = false;
        return;
      }
      out.push(new ObjectReader(entry, path, this.diags));
    });
    return valid ? out : undefined;
  }

  /** Every key never consumed is an error: unknown fields are not ignored. */
  finish(): void {
    for (const key of Object.keys(this.obj).sort()) {
      if (this.seen.has(key)) continue;
      this.report(
        "UNKNOWN_FIELD",
        joinPath(this.path, key),
        `unknown field \`${key}\``,
      );
    }
  }
}

function checkString(
  reader: ObjectReader,
  value: BoundaryValue,
  path: string,
  key: string,
  bounds: StringBounds,
): string | undefined {
  if (!isString(value)) {
    reader.report("INVALID_TYPE", path, `\`${key}\` must be a string`);
    return undefined;
  }
  if (value.length < bounds.min || value.length > bounds.max) {
    reader.report(
      bounds.code ?? "INVALID_LENGTH",
      path,
      `\`${key}\` must be ${bounds.min}–${bounds.max} characters`,
    );
    return undefined;
  }
  if (bounds.pattern !== undefined && !bounds.pattern.test(value)) {
    reader.report(
      bounds.code ?? "INVALID_VALUE",
      path,
      `\`${key}\` is malformed`,
    );
    return undefined;
  }
  return value;
}

function checkIdList(
  reader: ObjectReader,
  value: JsonValue,
  path: string,
  key: string,
): string[] | undefined {
  if (!Array.isArray(value)) {
    reader.report("INVALID_TYPE", path, `\`${key}\` must be an array`);
    return undefined;
  }
  if (value.length > MAX_LIST_IDS) {
    reader.report(
      "TOO_MANY_ITEMS",
      path,
      `\`${key}\` exceeds ${MAX_LIST_IDS} entries`,
    );
    return undefined;
  }
  const out: string[] = [];
  let valid = true;
  value.forEach((entry, index) => {
    const entryPath = indexPath(path, index);
    if (!isString(entry) || !isCapabilityId(entry)) {
      reader.report(
        "INVALID_ID",
        entryPath,
        `entry in \`${key}\` is not a capability id`,
      );
      valid = false;
      return;
    }
    if (out.includes(entry)) {
      reader.report(
        "DUPLICATE_ID",
        entryPath,
        `\`${entry}\` repeats in \`${key}\``,
      );
      valid = false;
      return;
    }
    out.push(entry);
  });
  return valid ? out : undefined;
}

export type NamedIdList = Readonly<{
  name: string;
  path: string;
  ids: readonly string[];
}>;

/** An id in two of the lists is an error, reported at its later occurrence. */
export function checkDisjoint(
  reader: ObjectReader,
  lists: readonly NamedIdList[],
): void {
  const firstSeen = new Map<string, string>();
  for (const list of lists) {
    list.ids.forEach((id, index) => {
      const earlier = firstSeen.get(id);
      if (earlier === undefined) {
        firstSeen.set(id, list.name);
        return;
      }
      reader.report(
        "CONFLICTING_SETS",
        indexPath(list.path, index),
        `\`${id}\` appears in both \`${earlier}\` and \`${list.name}\``,
      );
    });
  }
}

/** Entry point: the document must be a JSON object. */
export function rootReader(
  v: BoundaryValue,
  diags: Diagnostic[],
): ObjectReader | undefined {
  if (!isJsonObject(v)) {
    pushDiagnostic(
      diags,
      diagnostic("NOT_OBJECT", "", "document must be a JSON object"),
    );
    return undefined;
  }
  return new ObjectReader(v, "", diags);
}

export const isSlotName = isUnitName;
