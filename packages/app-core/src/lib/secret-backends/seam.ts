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

/** Catalog rendering needs no SDK, file parser, remote call or private configuration. */
export const secretBackendDeviceSeams = {
  authorization: (_connectionId: string): Authorization | null => null,
  revoke: async (_connectionId: string): Promise<void> => {
    throw new Error("Open this secret backend's settings to disconnect it.");
  },
};
