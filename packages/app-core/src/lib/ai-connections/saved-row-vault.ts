/** A saved workflow watches only its original committed row, never selecting a new route. */
import { subscribeDeviceRows } from "../device-connector-records.js";
import {
  type NativeConnectorRecord,
  loadNativeConnectorRecord,
} from "../native-connector-store.js";
import { assertVaultCredentials } from "../vault-credential-custody.js";
import { capturedAiCredentials } from "./credentials.js";
import { AiConnectionError } from "./types.js";
import { aiVaultSeams } from "./vault-guard.js";

/** A saved credential is observed by exact original bytes, not by whichever key is current later. */
async function watchOriginalCredentials(
  expected: NativeConnectorRecord | null,
  vault: Awaited<ReturnType<typeof aiVaultSeams.capture>>,
  lifetime: AbortController,
) {
  if (!expected?.privateState.credentials.ai_credential_reference)
    return { check() {}, release() {} };
  const custody = await capturedAiCredentials(expected, vault.tomb);
  const { vaultStore } = await import("../vault/store.js");
  let watching = true;
  const check = () => {
    if (!watching) return;
    vault.check();
    assertVaultCredentials(custody, vault.tomb, () =>
      lifetime.signal.throwIfAborted(),
    );
  };
  const observe = () => {
    try {
      check();
    } catch {
      lifetime.abort(
        new AiConnectionError(
          "stale",
          "The saved AI credential changed. Verify its replacement before continuing.",
        ),
      );
    }
  };
  const unsubscribe = vaultStore.subscribe(observe);
  const release = () => {
    if (!watching) return;
    watching = false;
    unsubscribe();
  };
  try {
    check();
    return { check, release };
  } catch (error) {
    release();
    throw error;
  }
}

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
  let releaseCredentials = () => {};
  let closeVault = () => {};
  try {
    checkRow();
    lifetime.signal.throwIfAborted();
    const vault = await aiVaultSeams.capture();
    closeVault = () => vault.close();
    const credentials = await watchOriginalCredentials(
      expected,
      vault,
      lifetime,
    );
    releaseCredentials = credentials.release;
    checkRow();
    lifetime.signal.throwIfAborted();
    let closed = false;
    return {
      ...vault,
      signal: AbortSignal.any([vault.signal, lifetime.signal]),
      check() {
        vault.check();
        checkRow();
        credentials.check();
        lifetime.signal.throwIfAborted();
      },
      /** Only the owning Save workflow hands its old row to the existing atomic publisher. */
      releaseSavedRow,
      /** Commit has admitted the replacement; only then may Save retire the old key. */
      releaseSavedCredentials: releaseCredentials,
      close(completed = false) {
        if (closed) return;
        closed = true;
        releaseSavedRow();
        releaseCredentials();
        vault.close(completed);
      },
    };
  } catch (error) {
    releaseSavedRow();
    releaseCredentials();
    closeVault();
    throw error;
  }
}
