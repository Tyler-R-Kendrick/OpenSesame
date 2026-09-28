/**
 * Settings › Live sessions as a file (ADR 0134; ADR 0150 §6):
 * `settings/live/transport.json`, the owner's transport profile — address
 * hints, ICE servers, relay only, carriers. Sealed in the tomb
 * (`lib/live/transport-store.ts`); the Form and this file write it through
 * one road, so the same refusals meet both.
 */

import {
  parseTransportText,
  readTransportText,
  writeLiveTransport,
} from "../../lib/live/transport-store.js";
import type {
  FileCheck,
  FileOutcome,
  VirtualFile,
  VirtualFileProvider,
} from "./virtual-files.js";

export const LIVE_DIRECTORY = "settings/live";
export const TRANSPORT_FILE = `${LIVE_DIRECTORY}/transport.json`;

const FILES: readonly VirtualFile[] = [
  { path: TRANSPORT_FILE, language: "json", readOnly: false, removable: false },
];

const UNKNOWN = "There is no such file.";

/** The profile file of whichever vault is open (`tomb()`). */
export function liveTransportFiles(tomb: () => string): VirtualFileProvider {
  return {
    list: () => FILES,
    read: (path) =>
      path === TRANSPORT_FILE ? readTransportText(tomb()) : Promise.resolve(""),
    check(path, raw): FileCheck {
      if (path !== TRANSPORT_FILE) return { ok: false, message: UNKNOWN };
      const read = parseTransportText(raw);
      return read.ok
        ? { ok: true }
        : { ok: false, message: read.errors[0] ?? "Refused." };
    },
    async write(path, raw): Promise<FileOutcome> {
      if (path !== TRANSPORT_FILE) return { ok: false, message: UNKNOWN };
      const read = parseTransportText(raw);
      if (!read.ok) return { ok: false, message: read.errors[0] ?? "Refused." };
      await writeLiveTransport(tomb(), read.transport);
      return { ok: true, path };
    },
    async remove() {
      return { ok: false, message: "This file cannot be removed." };
    },
  };
}
