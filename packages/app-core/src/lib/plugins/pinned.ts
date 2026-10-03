/**
 * A call is bound to the pairing it was issued for. The port resolves "the
 * paired daemon" when a request runs, so a call that outlived a re-pair, a
 * rotated key or a switched vault would otherwise reach the new daemon with
 * what was read from the old one.
 */

import {
  type PluginDaemon,
  type PluginDaemonTarget,
  PluginError,
} from "./client.js";

/** The same pairing: same daemon host and the same pairing revision. */
export function sameTarget(
  a: PluginDaemonTarget | null | undefined,
  b: PluginDaemonTarget | null | undefined,
): boolean {
  if (a === null || a === undefined || b === null || b === undefined)
    return (a ?? null) === (b ?? null);
  return a.host === b.host && a.revision === b.revision;
}

/**
 * The port as it stood for `pin`. Every request checks, in the same tick it
 * hands the call to the port, that the pairing is still `pin`, and says which
 * pairing it was issued for so the port can check again where it resolves one.
 */
export function pinnedTo(
  daemon: PluginDaemon,
  pin: PluginDaemonTarget,
): PluginDaemon {
  return {
    target: () => pin,
    request(path, init) {
      if (!sameTarget(daemon.target(), pin))
        return Promise.reject(new PluginError("target-changed"));
      return daemon.request(path, { ...init, expect: pin });
    },
  };
}
