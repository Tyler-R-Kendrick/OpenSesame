/** Invocation custody for a sealed restore; decryption/merge code loads only for the action. */
import type { VaultBodyPort } from "./store-device-key.js";
import type { ImportOptions } from "./store-import.js";

/** Code-loading seam only: it creates no vault owner, body port, or write admission. */
export const storeImportEntrySeams = {
  load: () => import("./store-import.js"),
};

/** Async decrypt and key vetting must never redirect a restore into a later vault session. */
export function guardedImportPort(
  port: VaultBodyPort,
  check: () => void,
): VaultBodyPort {
  const read =
    <T>(get: () => T) =>
    () => {
      check();
      return get();
    };
  return {
    tomb: read(port.tomb),
    open: read(port.open),
    carries: read(port.carries),
    header: read(port.header),
    body: read(port.body),
    mutate: (change) => {
      check();
      return port.mutate((body) => {
        check();
        change(body);
      });
    },
    publishKey: async (field) => {
      check();
      await port.publishKey(field);
      check();
    },
  };
}

/** Bind the existing public action; no destination or request is read again after loading code. */
export function bindSealedImport(
  getPort: () => VaultBodyPort,
  capture: () => () => void,
) {
  return (
    fileText: string,
    secret: string | Uint8Array,
    options: ImportOptions = {},
  ): Promise<number> => {
    const owner = capture();
    const operation = options.assertCurrent;
    const check = () => {
      owner();
      operation?.();
    };
    check();
    const port = guardedImportPort(getPort(), check);
    const request = Object.freeze({
      adoptIdentity: options.adoptIdentity === true,
    });
    const load = storeImportEntrySeams.load;
    // Raw-key inputs are consuming already. Transfer them before the new await,
    // so caller edits cannot change a held restore and no extra raw copy survives.
    const capturedSecret =
      secret instanceof Uint8Array ? new Uint8Array(secret) : secret;
    if (secret instanceof Uint8Array) secret.fill(0);
    return (async () => {
      try {
        const action = await load();
        check();
        return await action.importSealedInto(
          port,
          fileText,
          capturedSecret,
          request,
        );
      } finally {
        if (capturedSecret instanceof Uint8Array) capturedSecret.fill(0);
      }
    })();
  };
}
