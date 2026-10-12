import type { JsonObject } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { NativeMcpSchemaValidator } from "./native-mcp-schema-validator.js";

const validator = new NativeMcpSchemaValidator();
const unsafe: JsonObject = {
  type: "object",
  properties: { query: { type: "string", pattern: "^(a+)+$" } },
};
function refuses(schema: JsonObject) {
  expect(() => validator.getValidator(schema)).toThrow(
    expect.objectContaining({ code: "schema-limits" }),
  );
}
describe("MCP browser schema safety", () => {
  it("rejects the observed 32-character catastrophic pattern before regex construction", () => {
    const regex = vi.spyOn(globalThis, "RegExp");
    try {
      refuses(unsafe);
      expect(regex).not.toHaveBeenCalledWith("^(a+)+$", "u");
    } finally {
      regex.mockRestore();
    }
  });
  it.each(["^(a|aa)+$", "^[a-z]+[a-z]+$", "^a{999}$", "^(?=a)a$", "^(a)\\1$"])(
    "refuses unsupported backtracking constructs %s",
    (pattern) => {
      refuses({
        type: "object",
        properties: { query: { type: "string", pattern } },
      });
    },
  );
  it("validates fixed UUID and a single variable character class with finite local refs and unions", () => {
    const schema: JsonObject = {
      type: "object",
      properties: {
        id: { $ref: "#/$defs/uuid" },
        pattern: {
          anyOf: [{ type: "string", pattern: "^[a-z_-]+$" }, { type: "null" }],
        },
      },
      required: ["id", "pattern"],
      additionalProperties: false,
      $defs: {
        uuid: {
          type: "string",
          pattern:
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        },
      },
    };
    const validate = validator.getValidator(schema);
    expect(
      validate({
        id: "01234567-abcd-abcd-abcd-0123456789ab",
        pattern: "release_notes",
      }).valid,
    ).toBe(true);
    expect(validate({ id: "invalid", pattern: "release_notes" }).valid).toBe(
      false,
    );
    expect(schema).not.toHaveProperty("__absolute_uri__");
  });
  it.each([
    { $ref: "https://example.com/schema" },
    { $ref: "#" },
    { $defs: { x: { $ref: "#/$defs/x" } }, $ref: "#/$defs/x" },
    {
      $defs: { x: { $ref: "#/$defs/y" }, y: { $ref: "#/$defs/x" } },
      $ref: "#/$defs/x",
    },
    { $recursiveRef: "#" },
    { $dynamicRef: "#x" },
    { $id: "https://example.com/schema", type: "object" },
    { type: "object", properties: { url: { type: "string", format: "url" } } },
  ])(
    "refuses recursive/remote/rebased or unbounded built-in regex schemas",
    (schema) => refuses(schema),
  );
  it("bounds finite reference expansion rather than exponentially revisiting a small DAG", () => {
    const defs: JsonObject = { end: { type: "string" } };
    for (let n = 0; n < 10; n++)
      defs[`n${n}`] = {
        allOf: [
          { $ref: `#/$defs/${n === 0 ? "end" : `n${n - 1}`}` },
          { $ref: `#/$defs/${n === 0 ? "end" : `n${n - 1}`}` },
        ],
      };
    refuses({ $defs: defs, $ref: "#/$defs/n9" });
  });
  it("refuses large JSON child collections before queuing or validating them", () => {
    const validate = validator.getValidator({ type: "object" });
    expect(() =>
      validate({ rows: Array.from({ length: 10_000 }, () => 1) }),
    ).toThrow(expect.objectContaining({ code: "schema-limits" }));
    expect(() =>
      validate(
        Object.fromEntries(
          Array.from({ length: 10_000 }, (_, i) => [`v${i}`, 1]),
        ),
      ),
    ).toThrow(expect.objectContaining({ code: "schema-limits" }));
  });
  it("bounds quadratic collection comparison work for numeric data", () => {
    const validate = validator.getValidator({
      type: "object",
      properties: {
        rows: { type: "array", uniqueItems: true, items: { type: "integer" } },
      },
    });
    expect(() =>
      validate({ rows: Array.from({ length: 400 }, (_, i) => i) }),
    ).toThrow(expect.objectContaining({ code: "schema-limits" }));
    expect(validate({ rows: [1, 2, 3] }).valid).toBe(true);
    expect(validate({ rows: [1, 1] }).valid).toBe(false);
  });
  it("bounds deep schemas and oversized arguments before interpretation", () => {
    let schema: JsonObject = { type: "string" };
    for (let n = 0; n < 30; n++)
      schema = { type: "object", properties: { next: schema } };
    refuses(schema);
    const validate = validator.getValidator({ type: "object" });
    expect(() => validate({ query: "a".repeat(16_385) })).toThrow(
      expect.objectContaining({ code: "schema-limits" }),
    );
  });
  it("rejects patternProperties and nested union work before provider dispatch", () => {
    refuses({
      type: "object",
      patternProperties: { "^(a+)+$": { type: "string" } },
    });
    const validate = validator.getValidator({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`v${i}`, { type: "string" }]),
      ),
    });
    expect(() => validate({ query: "a".repeat(8192) })).toThrow(
      expect.objectContaining({ code: "schema-limits" }),
    );
  });
});
