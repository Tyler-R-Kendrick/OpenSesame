/**
 * The device duress code's status as a Settings file (ADR 0134; ADR 0155):
 * `settings/security/duress/status.json`, three facts and nothing else —
 * whether a code is armed, the profile it is armed under, and whether an
 * incident fence holds the device.
 *
 * Read-only, always. A duress code is set, replaced, removed and cleared in
 * the Duress sheet, a ceremony that checks the code against this device
 * first; no write to a file can do any of it. The file carries no code, no
 * trigger material, no seal, no incident id and no journal body, and, like
 * the sheet, it is the owner's: with no owner at the device it is not listed
 * and answers as if it did not exist.
 */

import type { VirtualFile, VirtualFileProvider } from "./virtual-files.js";

export const DURESS_DIRECTORY = "settings/security/duress";
export const DURESS_STATUS_FILE = `${DURESS_DIRECTORY}/status.json`;

const FILE: VirtualFile = {
  path: DURESS_STATUS_FILE,
  language: "json",
  readOnly: true,
  removable: false,
  readOnlyLabel: "Changed in the Duress sheet; read-only",
};

/** The device's status: armed, and how many incidents it has not cleared. */
export type DuressDeviceStatus = Readonly<{
  armed: boolean;
  incidents: number;
}>;

export type DuressFilePorts = Readonly<{
  /** The owner of an open vault is at the device. */
  owner(): boolean;
  status(): DuressDeviceStatus;
  /** The profile id an armed code is sealed under. */
  profileId: string;
}>;

const READ_ONLY = "This file is read-only.";

/** The status as the file says it: facts only, never an id or a count. */
export function duressStatusText(ports: DuressFilePorts): string {
  const { armed, incidents } = ports.status();
  return `${JSON.stringify(
    {
      armed,
      profile: armed ? ports.profileId : null,
      incident_fence: incidents > 0,
    },
    null,
    2,
  )}\n`;
}

export function duressStatusFiles(ports: DuressFilePorts): VirtualFileProvider {
  return {
    list: () => (ports.owner() ? [FILE] : []),
    read: async (path) => {
      if (path !== DURESS_STATUS_FILE || !ports.owner()) {
        throw new Error(`No file at ${path}.`);
      }
      return duressStatusText(ports);
    },
    check: () => ({ ok: false, message: READ_ONLY }),
    write: async () => ({ ok: false, message: READ_ONLY }),
    remove: async () => ({ ok: false, message: READ_ONLY }),
  };
}
