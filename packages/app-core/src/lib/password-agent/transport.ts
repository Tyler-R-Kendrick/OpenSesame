import { z } from "zod";
import {
  type JsonValue,
  jsonValueSchema,
  recordSchema,
} from "./provider-schema.js";
export type { RecordValue } from "./provider-schema.js";
export interface InvokeOptions {
  timeoutMs?: number | undefined;
  input?: string | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  account?: string | undefined;
  desktop?: boolean | undefined;
}
export interface PasswordAgentPort {
  runEnvFile?(
    content: string,
    command: readonly string[],
    options?: InvokeOptions,
  ): Promise<number>;
  invoke(args: readonly string[], options: InvokeOptions): Promise<string>;
  readMany?(
    references: readonly string[],
    options?: InvokeOptions,
  ): Promise<readonly string[]>;
  run?(
    args: readonly string[],
    command: readonly string[],
    env?: Readonly<Record<string, string>>,
    options?: InvokeOptions,
  ): Promise<number>;
}
export interface Scope {
  account?: string | undefined;
  vault?: string;
  desktop?: boolean | undefined;
}

export function record(value: JsonValue | undefined) {
  return recordSchema.parse(value);
}
export function string(value: JsonValue | undefined) {
  return z.string().parse(value);
}
export function records(value: JsonValue | undefined) {
  return z.array(recordSchema).parse(value);
}
export function id(value: JsonValue | undefined) {
  return z
    .string()
    .regex(/^[a-z0-9]{26}$/)
    .parse(value);
}
export async function invoke(
  port: PasswordAgentPort,
  args: readonly string[],
  options: InvokeOptions = {},
  failure = "1Password operation failed (details suppressed)",
): Promise<string> {
  try {
    return await port.invoke(args, options);
  } catch {
    throw new Error(failure);
  }
}
export async function json(
  port: PasswordAgentPort,
  args: readonly string[],
  options: InvokeOptions = {},
  failure?: string,
) {
  const raw = await invoke(port, args, options, failure);
  try {
    return jsonValueSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error(
      failure ?? "1Password returned invalid JSON (details suppressed)",
    );
  }
}
interface JsonScan {
  depth: number;
  quoted: boolean;
  escaped: boolean;
  start: number;
}
function quotedCharacter(scan: JsonScan, char: string) {
  if (scan.escaped) scan.escaped = false;
  else if (char === "\\") scan.escaped = true;
  else if (char === '"') scan.quoted = false;
}
function structuralCharacter(
  scan: JsonScan,
  char: string,
  index: number,
): boolean {
  if (char === '"') scan.quoted = true;
  else if (char === "{" || char === "[") {
    if (!scan.depth) scan.start = index;
    scan.depth++;
  } else if (char === "}" || char === "]") {
    scan.depth--;
    if (scan.depth < 0) throw new Error("Invalid JSON batch");
    return scan.depth === 0;
  } else if (!scan.depth && char.trim()) throw new Error("Invalid JSON batch");
  return false;
}
export function documents(input: string) {
  const result: JsonValue[] = [];
  const scan: JsonScan = { depth: 0, quoted: false, escaped: false, start: -1 };
  for (let index = 0; index < input.length; index++) {
    const char = input[index] ?? "";
    if (scan.quoted) {
      quotedCharacter(scan, char);
      continue;
    }
    if (structuralCharacter(scan, char, index)) {
      const value = jsonValueSchema.parse(
        JSON.parse(input.slice(scan.start, index + 1)),
      );
      result.push(...(Array.isArray(value) ? value : [value]));
      scan.start = -1;
    }
  }
  if (scan.depth || scan.quoted) throw new Error("Incomplete JSON batch");
  return result;
}
