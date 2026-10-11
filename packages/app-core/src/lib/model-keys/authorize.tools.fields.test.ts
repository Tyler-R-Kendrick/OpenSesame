import type { BoundaryObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_CASE,
  GEMINI_CASE,
  OPENAI_CASE,
  SCHEMA,
  inspect,
  refusalOf,
} from "./tools.test-support.js";

describe("tools on openai_chat, field by field", () => {
  const c = OPENAI_CASE;
  const fn = (inner: BoundaryObject) => ({ type: "function", function: inner });

  it("wants a function with a name, and nothing it does not define", () => {
    for (const tool of [
      fn({}),
      fn({ name: 7 }),
      fn({ name: "" }),
      fn({ name: "x", parameters: [] }),
      fn({ name: "x", description: 3 }),
      fn({ name: "x", extra: 1 }),
      { type: "function" },
      { type: "function", function: "weather" },
      { type: "custom", custom: { name: "x" } },
      { function: { name: "x" } },
      { ...fn({ name: "x" }), strict: true },
    ])
      expect(
        refusalOf(() => inspect(c, c.body({ tools: [tool] }))).reason,
        JSON.stringify(tool),
      ).toBe("body.tool");
    expect(() =>
      inspect(c, c.body({ tools: [fn({ name: "x" })] })),
    ).not.toThrow();
  });

  it("accepts the string choices and refuses any other string", () => {
    for (const choice of ["none", "auto", "required"])
      expect(() =>
        inspect(c, c.body({ tools: [c.tool], tool_choice: choice })),
      ).not.toThrow();
    expect(
      refusalOf(() =>
        inspect(c, c.body({ tools: [c.tool], tool_choice: "web_search" })),
      ).reason,
    ).toBe("body.tool");
  });
});

describe("tools on anthropic_messages, field by field", () => {
  const c = ANTHROPIC_CASE;

  it("wants a name and an input schema, and a type of custom or none", () => {
    for (const tool of [
      { name: "x" },
      { input_schema: SCHEMA },
      { name: 7, input_schema: SCHEMA },
      { name: "x", input_schema: [] },
      { name: "x", input_schema: "{}" },
      { name: "x", input_schema: SCHEMA, description: 3 },
      { name: "x", input_schema: SCHEMA, type: "web_search_20250305" },
      { name: "x", input_schema: SCHEMA, type: 7 },
    ])
      expect(
        refusalOf(() => inspect(c, c.body({ tools: [tool] }))).reason,
        JSON.stringify(tool),
      ).toBe("body.tool");
    for (const tool of [
      { name: "x", input_schema: SCHEMA },
      { name: "x", input_schema: SCHEMA, type: "custom" },
    ])
      expect(() => inspect(c, c.body({ tools: [tool] }))).not.toThrow();
  });

  it("accepts the four choice types and refuses any other", () => {
    for (const choice of [
      { type: "auto" },
      { type: "any", disable_parallel_tool_use: true },
      { type: "none" },
      { type: "tool", name: "x" },
    ])
      expect(() =>
        inspect(c, c.body({ tools: [c.tool], tool_choice: choice })),
      ).not.toThrow();
    for (const choice of [
      "auto",
      { type: "tool" },
      { type: "auto", name: "x" },
      { type: "bash_20250124" },
    ])
      expect(
        refusalOf(() =>
          inspect(c, c.body({ tools: [c.tool], tool_choice: choice })),
        ).reason,
        JSON.stringify(choice),
      ).toBe("body.tool");
  });
});

describe("tools on gemini_generate_content, field by field", () => {
  const c = GEMINI_CASE;

  it("wants function declarations with a name, in either spelling", () => {
    for (const tool of [
      { function_declarations: [] },
      { functionDeclarations: [{ name: "x", parameters: SCHEMA }] },
      {
        function_declarations: [{ name: "x" }, { name: "y", description: "d" }],
      },
    ])
      expect(() => inspect(c, c.body({ tools: [tool] }))).not.toThrow();
    for (const tool of [
      { function_declarations: {} },
      { function_declarations: [{}] },
      { function_declarations: [{ name: 7 }] },
      { function_declarations: [{ name: "x", parameters: [] }] },
      { function_declarations: [{ name: "x", extra: 1 }] },
      { function_declarations: [{ name: "x", behavior: "NON_BLOCKING" }] },
      {
        function_declarations: [{ name: "x" }],
        functionDeclarations: [{ name: "y" }],
      },
    ])
      expect(
        refusalOf(() => inspect(c, c.body({ tools: [tool] }))).reason,
        JSON.stringify(tool),
      ).toBe("body.tool");
  });

  it("accepts a function calling config and nothing else in a toolConfig", () => {
    for (const toolConfig of [
      { function_calling_config: { mode: "AUTO" } },
      {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["x"] },
      },
      { function_calling_config: { mode: "NONE" } },
      {},
    ])
      expect(() =>
        inspect(c, c.body({ tools: [c.tool], toolConfig })),
      ).not.toThrow();
    for (const toolConfig of [
      { function_calling_config: { allowed_function_names: [7] } },
      { function_calling_config: {}, functionCallingConfig: {} },
      { retrieval_config: { lat_lng: { latitude: 1, longitude: 2 } } },
      { function_calling_config: { mode: 7 } },
      "ANY",
    ])
      expect(
        refusalOf(() => inspect(c, c.body({ tools: [c.tool], toolConfig })))
          .reason,
        JSON.stringify(toolConfig),
      ).toBe("body.tool");
  });
});
