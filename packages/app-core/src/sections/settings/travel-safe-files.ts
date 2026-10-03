/**
 * Travel mode's safe list as a Settings file (ADR 0134; ADR 0143):
 * `settings/security/travel/safe.json`, `{ "safe": ["personal", "prj_…"] }`.
 *
 * It names vault ids and nothing else — never a vault's sealed name, an item,
 * a folder or a value. The Travel sheet and this file write it through one
 * road (`writeSafeFlags`), so a mark made in either is the one stored mark.
 * A mark may only name a vault this device holds, so a stale id cannot mark
 * safe a vault that later returns under the same name.
 *
 * The owner's file, like the owner's sheet: with no owner at the device (a
 * guest, a locked vault) it is not listed, and nothing reads or writes it.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type {
  FileCheck,
  FileOutcome,
  VirtualFile,
  VirtualFileProvider,
} from "./virtual-files.js";

export const TRAVEL_DIRECTORY = "settings/security/travel";
export const TRAVEL_SAFE_FILE = `${TRAVEL_DIRECTORY}/safe.json`;

const FILE: VirtualFile = {
  path: TRAVEL_SAFE_FILE,
  language: "json",
  readOnly: false,
  removable: false,
};

/** What the file is drawn from and written through: the Travel sheet's own seams. */
export type TravelSafePorts = Readonly<{
  /** The owner of an open vault is at the device. */
  owner(): boolean;
  /** The vaults a mark may name: every tomb on the device but the guest's. */
  vaultIds(): readonly string[];
  /** The marks, kept only where `present` still lists them. */
  read(present: readonly string[]): ReadonlySet<string>;
  /** The sheet's write. */
  write(safe: ReadonlySet<string>): Promise<void>;
  /** A duress response holds the device: travel changes are refused. */
  held(): boolean;
  /** The browser keeps what is written past this session. */
  durable(): boolean;
}>;

type Parsed =
  | { readonly ok: true; readonly safe: ReadonlySet<string> }
  | { readonly ok: false; readonly message: string };

const UNKNOWN = "There is no such file.";
const REFUSED = "This device is held; travel changes are refused.";

/** The file's text for a set of marks: sorted ids, as they are stored. */
export function travelSafeText(safe: ReadonlySet<string>): string {
  return `${JSON.stringify({ safe: [...safe].sort() }, null, 2)}\n`;
}

/** Parse a write against the vaults the device holds. */
export function parseTravelSafe(
  text: string,
  present: readonly string[],
): Parsed {
  let document: BoundaryValue;
  try {
    document = JSON.parse(text);
  } catch {
    return { ok: false, message: "The file is not valid JSON." };
  }
  if (!isJsonObject(document)) {
    return { ok: false, message: 'Expected an object: {"safe": [...]}.' };
  }
  const keys = Object.keys(document);
  if (keys.length !== 1 || keys[0] !== "safe") {
    return { ok: false, message: 'Only the key "safe" is kept here.' };
  }
  const ids = document.safe;
  if (!Array.isArray(ids) || !ids.every(isString)) {
    return { ok: false, message: '"safe" lists vault ids, as strings.' };
  }
  const known = new Set(present);
  if (!ids.every((id) => known.has(id))) {
    return {
      ok: false,
      message: "A vault listed in safe is not on this device.",
    };
  }
  return { ok: true, safe: new Set(ids) };
}

export function travelSafeFiles(ports: TravelSafePorts): VirtualFileProvider {
  const refusal = (path: string, text: string): FileCheck => {
    if (path !== TRAVEL_SAFE_FILE || !ports.owner()) {
      return { ok: false, message: UNKNOWN };
    }
    if (ports.held()) return { ok: false, message: REFUSED };
    const parsed = parseTravelSafe(text, ports.vaultIds());
    return parsed.ok ? { ok: true } : { ok: false, message: parsed.message };
  };
  return {
    list: () => (ports.owner() ? [FILE] : []),
    read: async (path) => {
      if (path !== TRAVEL_SAFE_FILE || !ports.owner()) {
        throw new Error(`No file at ${path}.`);
      }
      return travelSafeText(ports.read(ports.vaultIds()));
    },
    check: refusal,
    async write(path, text): Promise<FileOutcome> {
      const refused = refusal(path, text);
      if (!refused.ok) return refused;
      const parsed = parseTravelSafe(text, ports.vaultIds());
      if (!parsed.ok) return parsed;
      try {
        await ports.write(parsed.safe);
      } catch {
        return { ok: false, message: "The browser would not keep it." };
      }
      const stored: FileOutcome = {
        ok: true,
        path,
        text: travelSafeText(parsed.safe),
      };
      return ports.durable()
        ? stored
        : { ...stored, tone: "warn", message: "Kept for this session only." };
    },
    remove: async () => ({
      ok: false,
      message: "This file cannot be removed.",
    }),
  };
}
