/**
 * Which tools a call may carry (ADR 0189 §6).
 *
 * A provider bills a tool it runs for the caller (a web search, a code
 * sandbox, a computer session) outside the tokens a budget counts, so a key
 * carries only what runs on the caller's side: a plain function declaration.
 * The rule is closed. A tool is an object with exactly the fields below, and
 * anything else, a `type` that names a provider's tool or a field this module
 * does not know, is refused, so a tool added next year is refused the day it
 * ships. `tool_choice` and `toolConfig` are held to the same list, because a
 * choice may name only what was declared.
 */
import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isBoolean,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { refuse } from "./errors.js";

const NAME_LENGTH = 128;
const OPENAI_CHOICES: readonly string[] = ["none", "auto", "required"];
const GEMINI_MODES: readonly string[] = ["AUTO", "ANY", "NONE", "VALIDATED"];

function refused(): never {
  return refuse("insufficient_scope", "body.tool");
}

/** An object that has no field outside `fields`. */
function closed(value: BoundaryValue, fields: readonly string[]): JsonObject {
  if (!isJsonObject(value)) return refused();
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) refused();
  }
  return value;
}

function list(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : refused();
}

function nameOf(value: JsonValue | undefined): void {
  if (!isString(value) || value.length < 1 || value.length > NAME_LENGTH)
    refused();
}

function describedBy(value: JsonValue | undefined): void {
  if (value !== undefined && !isString(value)) refused();
}

/** A schema is an object; what is in it is the caller's own business. */
function schemaOf(value: JsonValue | undefined): void {
  if (!isJsonObject(value)) refused();
}

function flagOf(value: JsonValue | undefined): void {
  if (value !== undefined && !isBoolean(value)) refused();
}

export function openaiTools(body: JsonObject): void {
  if (body.tools !== undefined) {
    for (const tool of list(body.tools)) {
      const entry = closed(tool, ["type", "function"]);
      if (entry.type !== "function") refused();
      const declared = closed(entry.function, [
        "name",
        "description",
        "parameters",
      ]);
      nameOf(declared.name);
      describedBy(declared.description);
      if (declared.parameters !== undefined) schemaOf(declared.parameters);
    }
  }
  const choice = body.tool_choice;
  if (choice === undefined) return;
  if (isString(choice)) {
    if (!OPENAI_CHOICES.includes(choice)) refused();
    return;
  }
  const entry = closed(choice, ["type", "function"]);
  if (entry.type !== "function") refused();
  nameOf(closed(entry.function, ["name"]).name);
}

export function anthropicTools(body: JsonObject): void {
  if (body.tools !== undefined) {
    for (const tool of list(body.tools)) {
      const entry = closed(tool, [
        "name",
        "description",
        "input_schema",
        "type",
      ]);
      nameOf(entry.name);
      describedBy(entry.description);
      schemaOf(entry.input_schema);
      // A client tool has no type, or `custom`; every other type is a tool Anthropic runs.
      if (entry.type !== undefined && entry.type !== "custom") refused();
    }
  }
  if (body.tool_choice === undefined) return;
  const choice = closed(body.tool_choice, [
    "type",
    "name",
    "disable_parallel_tool_use",
  ]);
  flagOf(choice.disable_parallel_tool_use);
  const kind = choice.type;
  if (kind === "tool") nameOf(choice.name);
  else if (
    choice.name !== undefined ||
    (kind !== "auto" && kind !== "any" && kind !== "none")
  )
    refused();
}

/** Either spelling of a Gemini field, and never both. */
function spelled(
  entry: JsonObject,
  snake: string,
  camel: string,
): JsonValue | undefined {
  if (entry[snake] !== undefined && entry[camel] !== undefined) refused();
  return entry[snake] ?? entry[camel];
}

export function geminiTools(body: JsonObject): void {
  if (body.tools !== undefined) {
    for (const tool of list(body.tools)) {
      const entry = closed(tool, [
        "function_declarations",
        "functionDeclarations",
      ]);
      for (const declaration of list(
        spelled(entry, "function_declarations", "functionDeclarations"),
      )) {
        const declared = closed(declaration, [
          "name",
          "description",
          "parameters",
        ]);
        nameOf(declared.name);
        describedBy(declared.description);
        if (declared.parameters !== undefined) schemaOf(declared.parameters);
      }
    }
  }
  if (body.toolConfig === undefined) return;
  const config = closed(body.toolConfig, [
    "function_calling_config",
    "functionCallingConfig",
  ]);
  const calling = spelled(
    config,
    "function_calling_config",
    "functionCallingConfig",
  );
  if (calling === undefined) return;
  const setting = closed(calling, [
    "mode",
    "allowed_function_names",
    "allowedFunctionNames",
  ]);
  if (setting.mode !== undefined) {
    if (!isString(setting.mode) || !GEMINI_MODES.includes(setting.mode))
      refused();
  }
  const names = spelled(
    setting,
    "allowed_function_names",
    "allowedFunctionNames",
  );
  if (names !== undefined) {
    for (const name of list(names)) nameOf(name);
  }
}
