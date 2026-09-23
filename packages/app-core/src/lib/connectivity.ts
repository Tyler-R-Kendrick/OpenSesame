import { isOnline as hostOnline, maybeEnvironment } from "../ports.js";
/** Whether the device believes it has a network; true where the host cannot tell. */
export function isOnline(): boolean {
  return hostOnline();
}

/** Calls `cb` with each change; a host with no network signal never calls it. */
export function subscribeConnectivity(
  cb: (online: boolean) => void,
): () => void {
  return maybeEnvironment()?.onOnlineChange(cb) ?? (() => {});
}
