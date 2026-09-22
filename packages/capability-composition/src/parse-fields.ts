/**
 * Strict field readers over a `BoundaryValue` object.
 *
 * Every reader records the key it consumed; `finish()` turns every key it
 * never saw into an `UNKNOWN_FIELD` diagnostic. Readers return `undefined`
 * on failure and never throw; the caller assembles the document only when
 * every field came back defined and the diagnostic list is empty.
 */
import {
  type JsonObject,
  type JsonValue,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { type Diagnostic, diagnostic, pushDiagnostic } from "./diagnostics.js";
import { isOpaqueId } from "./ids.js";
import {
  MAX_LIST_IDS,
  MAX_STRING_LIST,
  type Report,
  type StringBounds,
  checkIdList,
  checkString,
  indexPath,
  joinPath,
} from "./parse-primitives.js";

export class ObjectReader {
  private readonly seen = new Set<string>();

  constructor(
    private readonly obj: JsonObject,
    readonly path: string,
    readonly diags: Diagnostic[],
  ) {}

  readonly report: Report = (code, path, message) => {
    pushDiagnostic(this.diags, diagnostic(code, path, message));
  };

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
    return checkString(this.report, field.value, field.path, key, bounds);
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
    return checkIdList(this.report, field.value, field.path, key);
  }

  /** `null` and `[]` are distinct outcomes and both survive the parse. */
  nullableIdList(key: string): string[] | null | undefined {
    const field = this.raw(key);
    if (field === undefined) return undefined;
    if (field.value === null) return null;
    return checkIdList(this.report, field.value, field.path, key);
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
      const value = checkString(this.report, entry, path, key, bounds);
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
