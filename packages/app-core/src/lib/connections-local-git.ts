import {
  forgetLocalGitRemote,
  isLocalGitRemoteId,
} from "./git-remote-local.js";
export {
  listLocalGitConnections,
  localGitToConnection,
  mergeLocalGitConnections,
} from "./connections-local-git-view.js";
import { revokeDeviceConnection } from "./device-connectors.js";
import { unbindHistoryConnection } from "./history-backups.js";

export async function revokeLocalGitConnection(id: string): Promise<{
  revoked: boolean;
  providerRevocation: "ok" | "unsupported" | "failed";
} | null> {
  if (!isLocalGitRemoteId(id)) return null;
  const removed = await forgetLocalGitRemote(id);
  if (!removed) return null;
  // Saving a forge remote mirrors its credential into the device store.
  await revokeDeviceConnection(id);
  unbindHistoryConnection(id);
  return { revoked: true, providerRevocation: "unsupported" };
}
