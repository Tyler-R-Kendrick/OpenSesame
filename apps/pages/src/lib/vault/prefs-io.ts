import {
  type JsonObject,
  type JsonValue,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { readFile, writeFile } from "../vfs.js";

export const PREFS_CONFIG_PATH = "config/prefs";
export const PREFS_SOURCE_CONFIG_PATH = "config/prefs.source.yaml";

const utf8 = new TextEncoder();
const utf8decode = new TextDecoder();

export async function writePrefsJson(
  tomb: string,
  prefs: JsonObject,
): Promise<void> {
  await writeFile(tomb, PREFS_CONFIG_PATH, utf8.encode(JSON.stringify(prefs)));
}

function asJsonValue(value: JsonValue): JsonValue {
  if (
    value === null ||
    isString(value) ||
    isNumber(value) ||
    isBoolean(value) ||
    Array.isArray(value) ||
    isJsonObject(value)
  ) {
    return value;
  }
  return {};
}

export async function readPrefsJson(tomb: string): Promise<JsonValue> {
  const parsed = overlapCast(
    JSON.parse(utf8decode.decode(await readFile(tomb, PREFS_CONFIG_PATH))),
  );
  return asJsonValue(parsed);
}

export async function writePrefsSourceFile(
  tomb: string,
  source: string,
): Promise<void> {
  await writeFile(tomb, PREFS_SOURCE_CONFIG_PATH, utf8.encode(source));
}

export async function readPrefsSourceFile(
  tomb: string,
): Promise<string | null> {
  try {
    return utf8decode.decode(await readFile(tomb, PREFS_SOURCE_CONFIG_PATH));
  } catch {
    return null;
  }
}
