import { readFile, writeFile } from "../vfs.js";

export const PREFS_CONFIG_PATH = "config/prefs";
export const PREFS_SOURCE_CONFIG_PATH = "config/prefs.source.yaml";

const utf8 = new TextEncoder();
const utf8decode = new TextDecoder();

export async function writePrefsJson(
  tomb: string,
  prefs: object,
): Promise<void> {
  await writeFile(tomb, PREFS_CONFIG_PATH, utf8.encode(JSON.stringify(prefs)));
}

export async function readPrefsJson(tomb: string): Promise<unknown> {
  return JSON.parse(utf8decode.decode(await readFile(tomb, PREFS_CONFIG_PATH)));
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
