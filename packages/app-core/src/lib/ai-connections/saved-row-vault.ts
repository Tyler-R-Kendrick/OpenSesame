/** A saved workflow watches only its original committed row, never selecting a new route. */
import { subscribeDeviceRows } from "../device-connector-records.js";
import { loadNativeConnectorRecord } from "../native-connector-store.js";
import { AiConnectionError } from "./types.js";
import { aiVaultSeams } from "./vault-guard.js";

export async function captureSavedAiVault(id?: string) {
  const expected = id ? loadNativeConnectorRecord(id) : null;
  const lifetime = new AbortController();
  let watching = true;
  const checkRow = () => {
    if (!id || !watching || lifetime.signal.aborted) return;
    try {
      const current = loadNativeConnectorRecord(id);
      if (
        expected &&
        current &&
        current.revision === expected.revision &&
        current.configuration.fingerprint === expected.configuration.fingerprint
      )
        return;
    } catch {
      // A removed, invalid or unreadable original row grants no continued use.
    }
    lifetime.abort(
      new AiConnectionError(
        "stale",
        "This AI connection changed. Reload before continuing.",
      ),
    );
  };
  const unsubscribe = id ? subscribeDeviceRows(checkRow) : () => {};
  const releaseSavedRow = () => {
    if (!watching) return;
    watching = false;
    unsubscribe();
  };
  try {
    checkRow();
    lifetime.signal.throwIfAborted();
    const vault = await aiVaultSeams.capture();
    let closed = false;
    return {
      ...vault,
      signal: AbortSignal.any([vault.signal, lifetime.signal]),
      check() {
        vault.check();
        checkRow();
        lifetime.signal.throwIfAborted();
      },
      /** Only the owning Save workflow hands its old row to the existing atomic publisher. */
      releaseSavedRow,
      close(completed = false) {
        if (closed) return;
        closed = true;
        releaseSavedRow();
        vault.close(completed);
      },
    };
  } catch (error) {
    releaseSavedRow();
    throw error;
  }
}
