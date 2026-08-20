import {
  assertNoPlaintextInSealedJson as assertNoPlaintextInSealedJsonImpl,
  createCursor as createCursorImpl,
  loadSealedStore as loadSealedStoreImpl,
  parseSealedStore as parseSealedStoreImpl,
  persistSealedStore as persistSealedStoreImpl,
} from "@opensesame/client-core";

export const clientCoreSeams = {
  assertNoPlaintextInSealedJson: assertNoPlaintextInSealedJsonImpl,
  createCursor: createCursorImpl,
  loadSealedStore: loadSealedStoreImpl,
  parseSealedStore: parseSealedStoreImpl,
  persistSealedStore: persistSealedStoreImpl,
};

export function assertNoPlaintextInSealedJson(
  ...args: Parameters<typeof assertNoPlaintextInSealedJsonImpl>
): ReturnType<typeof assertNoPlaintextInSealedJsonImpl> {
  return clientCoreSeams.assertNoPlaintextInSealedJson(...args);
}

export function createCursor(
  ...args: Parameters<typeof createCursorImpl>
): ReturnType<typeof createCursorImpl> {
  return clientCoreSeams.createCursor(...args);
}

export function loadSealedStore(
  ...args: Parameters<typeof loadSealedStoreImpl>
): ReturnType<typeof loadSealedStoreImpl> {
  return clientCoreSeams.loadSealedStore(...args);
}

export function parseSealedStore(
  ...args: Parameters<typeof parseSealedStoreImpl>
): ReturnType<typeof parseSealedStoreImpl> {
  return clientCoreSeams.parseSealedStore(...args);
}

export function persistSealedStore(
  ...args: Parameters<typeof persistSealedStoreImpl>
): ReturnType<typeof persistSealedStoreImpl> {
  return clientCoreSeams.persistSealedStore(...args);
}
