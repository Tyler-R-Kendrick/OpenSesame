import { identity, unavailable } from "./native-vault-data.js";
import { createNativeVaultLocks } from "./native-vault-locks.js";
export function createNativeVaultContext(
  stateDir: string,
  executable?: string,
) {
  const native = createNativeVaultLocks(stateDir, executable);
  function capture(
    original: () => void,
    tomb?: string,
    credentialOnly = false,
  ) {
    original();
    const held = native.custody();
    const process =
      held.body ??
      (credentialOnly ? held.credential : undefined) ??
      unavailable();
    const body = held.body !== undefined;
    if (!process || (tomb !== undefined && held.tomb !== tomb)) unavailable();
    let closed = false;
    function check() {
      original();
      process.check();
      if (
        closed ||
        (body ? native.custody().body : native.custody().credential) !== process
      )
        unavailable();
    }
    return {
      process,
      check,
      async close() {
        closed = true;
      },
      async revalidateRoot() {
        check();
        await process.request({ kind: "validate_state" });
        check();
      },
      async readOriginalStateIdentity() {
        check();
        const value = await identity(process);
        check();
        return value;
      },
    };
  }

  return { native, capture };
}
export type NativeVaultContext = ReturnType<typeof createNativeVaultContext>;
