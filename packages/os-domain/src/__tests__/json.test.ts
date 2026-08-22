import { describe, expect, it } from "vitest";
import {
  type JsonObject,
  isBoolean,
  isFunction,
  isJsonObject,
  isNumber,
  isString,
  isTypeofObject,
  isUndefined,
  overlapCast,
  readJsonObject,
  readString,
} from "../json.js";

describe("json boundary helpers", () => {
  it("narrows JSON primitives", () => {
    const value: string | number = "ok";
    expect(isString(value)).toBe(true);
    expect(isNumber(value)).toBe(false);
    expect(isBoolean(false)).toBe(true);
  });

  it("treats null as typeof object and not a JSON object", () => {
    expect(isTypeofObject(null)).toBe(true);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject({ a: 1 })).toBe(true);
  });

  it("detects functions, missing values, and overlap casts", () => {
    expect(isFunction(() => 1)).toBe(true);
    expect(isUndefined(undefined)).toBe(true);
    const raw = { id: "1" };
    expect(overlapCast(raw).id).toBe("1");
    const named: JsonObject = overlapCast(raw);
    expect(named.id).toBe("1");
  });

  it("reads JSON object and string fields", () => {
    expect(readJsonObject({ a: 1 })).toEqual({ a: 1 });
    expect(readJsonObject("nope")).toBeUndefined();
    expect(readString("ok")).toBe("ok");
    expect(readString(1)).toBeUndefined();
  });
});
