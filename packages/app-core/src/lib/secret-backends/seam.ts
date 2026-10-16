import type { Connection } from "../connections.js";

type Authorization = Pick<
  Connection,
  | "status"
  | "statusDetail"
  | "grantedScopes"
  | "accountLabel"
  | "expiresAt"
  | "refreshable"
>;
const listeners = new Set<() => void>();
let revision = 0;

/** Catalog rendering needs no SDK, file parser, remote call or private configuration. */
export const secretBackendDeviceSeams = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  snapshot: (): number => revision,
  changed(): void {
    revision += 1;
    for (const listener of [...listeners]) listener();
  },
  authorization: (_connectionId: string): Authorization | null => null,
  revoke: async (_connectionId: string): Promise<void> => {
    throw new Error("Open this secret backend's settings to disconnect it.");
  },
};
