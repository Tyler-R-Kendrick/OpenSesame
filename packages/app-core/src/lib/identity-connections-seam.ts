/** Device connector readers and removal never need to import an identity adapter. */
import type { Connection } from "./connections.js";
type IdentityAuthorization = Pick<
  Connection,
  | "status"
  | "statusDetail"
  | "grantedScopes"
  | "accountLabel"
  | "expiresAt"
  | "refreshable"
>;
export const identityConnectionDeviceSeams = {
  authorization: (_connectionId: string): IdentityAuthorization | null => null,
  revoke: async (_connectionId: string): Promise<void> => {
    throw new Error("Open Identity integrations to disconnect this connection");
  },
};
