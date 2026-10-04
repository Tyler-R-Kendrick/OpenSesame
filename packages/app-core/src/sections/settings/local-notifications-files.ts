/**
 * Settings › Capabilities › Local notifications as a file (ADR 0134, ADR
 * 0162): `settings/capabilities/local-notifications.json`, the ordered places
 * this device tells its person that a request is waiting. Sealed in the vault
 * (`lib/local-notifications/preference.ts`); the form's keys and this file
 * write it through one road, so the same refusals meet both.
 */

import {
  parsePreference,
  readPreference,
  serializePreference,
  writePreference,
} from "../../lib/local-notifications/preference.js";
import type {
  FileCheck,
  FileOutcome,
  VirtualFile,
  VirtualFileProvider,
} from "./virtual-files.js";

export const LOCAL_NOTIFICATIONS_FILE =
  "settings/capabilities/local-notifications.json";

const FILES: readonly VirtualFile[] = [
  {
    path: LOCAL_NOTIFICATIONS_FILE,
    language: "json",
    readOnly: false,
    removable: false,
  },
];

const UNKNOWN = "There is no such file.";

/** The preference file of whichever vault is open (`tomb()`). */
export function localNotificationFiles(
  tomb: () => string,
): VirtualFileProvider {
  return {
    list: () => FILES,
    read: async (path) =>
      path === LOCAL_NOTIFICATIONS_FILE
        ? serializePreference(await readPreference(tomb()))
        : "",
    check(path, raw): FileCheck {
      if (path !== LOCAL_NOTIFICATIONS_FILE)
        return { ok: false, message: UNKNOWN };
      const read = parsePreference(raw);
      return read.ok ? { ok: true } : { ok: false, message: read.error };
    },
    async write(path, raw): Promise<FileOutcome> {
      if (path !== LOCAL_NOTIFICATIONS_FILE)
        return { ok: false, message: UNKNOWN };
      const read = parsePreference(raw);
      if (!read.ok) return { ok: false, message: read.error };
      await writePreference(tomb(), read.preference);
      return { ok: true, path };
    },
    async remove() {
      return { ok: false, message: "This file cannot be removed." };
    },
  };
}
