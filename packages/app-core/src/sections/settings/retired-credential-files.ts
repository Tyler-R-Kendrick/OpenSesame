import type { retiredCredentialStatus } from "../../lib/retired-credentials/index.js";
import type { VirtualFile, VirtualFileProvider } from "./virtual-files.js";

export const RETIRED_CREDENTIAL_STATUS_FILE =
  "settings/security/decoy/retired-passwords.json";
const FILE: VirtualFile = {
  path: RETIRED_CREDENTIAL_STATUS_FILE,
  language: "json",
  readOnly: true,
  removable: false,
  readOnlyLabel: "Changed in the Retired passwords sheet; read-only",
};

/** Counts and response choices only: never verifier material, passwords, or evidence identifiers. */
export function retiredCredentialFiles(ports: {
  owner(): boolean;
  status(): ReturnType<typeof retiredCredentialStatus>;
}): VirtualFileProvider {
  const readOnly = () => ({
    ok: false as const,
    message: "This file is read-only.",
  });
  return {
    list: () => (ports.owner() ? [FILE] : []),
    read: async (path) => {
      if (path !== FILE.path || !ports.owner())
        throw new Error(`No file at ${path}.`);
      let status: ReturnType<typeof retiredCredentialStatus>;
      try {
        status = ports.status();
      } catch {
        return `${JSON.stringify({ local_only: true, available: false }, null, 2)}\n`;
      }
      return `${JSON.stringify({ local_only: true, observations: status.events.length, traps: status.traps.map((trap) => ({ response: trap.response })), durable: status.durable }, null, 2)}\n`;
    },
    check: readOnly,
    write: async () => readOnly(),
    remove: async () => readOnly(),
  };
}
