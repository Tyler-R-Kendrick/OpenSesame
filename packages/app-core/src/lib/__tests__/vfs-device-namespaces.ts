/** Separate simulated devices route actual admission maps alongside their file adapters. */
import { vi } from "vitest";
import * as keyAdmission from "../vfs-key-admission.js";

type DeviceNamespaceSelection = {
  current: object | null;
  installedFactories: number;
};
export const deviceVfsNamespace: DeviceNamespaceSelection = {
  current: null,
  installedFactories: 0,
};

/** Only suites simulating independent devices install the transparent routing. */
export function installDeviceVfsNamespaces(testPath: string | undefined): void {
  const suites = [
    "tailnet-sync/password-sync.test.ts",
    "tailnet-sync/two-devices.test.ts",
    "tailnet-sync/device-identity-sync.test.ts",
    "tailnet-sync/project-vaults.test.ts",
    "tailnet-sync/skew-and-fields.test.ts",
    "tailnet-sync/device-identity-restore-sync.test.ts",
    "vault/device-key-hostile.test.ts",
  ];
  if (!testPath || !suites.some((suite) => testPath.endsWith(suite))) return;

  const makeAdmission = keyAdmission.makeVfsKeyAdmission;
  vi.spyOn(keyAdmission, "makeVfsKeyAdmission").mockImplementation(
    (keys, readHeader) => {
      deviceVfsNamespace.installedFactories += 1;
      const fallback = {
        get: keys.get.bind(keys),
        set: keys.set.bind(keys),
        delete: keys.delete.bind(keys),
        has: keys.has.bind(keys),
        clear: keys.clear.bind(keys),
      };
      const devices = new WeakMap<object, Map<string, CryptoKey>>();
      const selected = () => {
        const device = deviceVfsNamespace.current;
        if (!device) return fallback;
        let own = devices.get(device);
        if (!own) {
          own = new Map<string, CryptoKey>();
          devices.set(device, own);
        }
        return own;
      };
      keys.get = (tomb) => selected().get(tomb);
      keys.set = (tomb, key) => {
        selected().set(tomb, key);
        return keys;
      };
      keys.delete = (tomb) => selected().delete(tomb);
      keys.has = (tomb) => selected().has(tomb);
      keys.clear = () => selected().clear();
      // The production factory owns all admission and cryptographic decisions.
      return makeAdmission(keys, readHeader);
    },
  );
}
