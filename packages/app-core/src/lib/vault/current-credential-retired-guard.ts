/** Reverse collision exclusion; caller owns its actual credential publication, never a DATA verdict. */
import { host } from "../../host.js";
import { CREDENTIAL_LOCK_NAME } from "../retired-credentials/credential-lock.js";
import {
  captureRetiredOperationLockData,
  checkRetiredOperationGrant,
} from "./captured-retired-operation-ports.js";
import { disposeOriginalCommandData } from "./original-command-retirement-data.js";
import type { PhysicalDeviceRecordReader } from "./physical-device-record-port.js";
import { captureRetiredDeviceReaderIdentity } from "./retired-owner-reader-identity.js";
const bindOriginal = Function.prototype.call.bind(Function.prototype.bind);
/** Use only within the existing owner's actual retained CRED transaction; this helper acquires no lock. */
export async function refuseRetainedCurrentCredentialData(
  reader: PhysicalDeviceRecordReader,
  candidate: string,
  check: () => void,
): Promise<void> {
  check();
  const { matchDeviceRetiredCredentialData } = await import(
    "../retired-credentials/device-global-match-data.js"
  );
  check();
  if ((await matchDeviceRetiredCredentialData(reader, candidate, check)).length)
    throw new Error(
      "That credential is retained as a retired credential on this device.",
    );
  check();
}
/** Capture the original physical inventory and retain actual CRED through the caller's publication. */
export async function withCurrentCredentialRetiredGuard<T>(
  candidate: string,
  original: () => void,
  work: (check: () => void) => Promise<T>,
): Promise<T> {
  original();
  const installed = host();
  const port = installed.physicalDeviceRecords;
  if (!port) {
    if (
      installed.originFiles ||
      installed.physicalVaultAuthentication ||
      installed.physicalCurrentCredentialCatalogue ||
      installed.physicalVaultPublication
    )
      throw new Error(
        "Original retired credential inventory is required before changing credentials.",
      );
    const memoryCheck = () => {
      original();
      if (
        host() !== installed ||
        installed.physicalDeviceRecords ||
        installed.originFiles ||
        installed.physicalVaultAuthentication ||
        installed.physicalCurrentCredentialCatalogue ||
        installed.physicalVaultPublication
      )
        throw new Error("Original memory-only credential context changed.");
    };
    memoryCheck();
    const result = await work(memoryCheck);
    memoryCheck();
    return result;
  }
  const captured = captureRetiredOperationLockData(original);
  const capture = port.capture;
  let readerIdentity = () => {};
  const check = () => {
    captured.check();
    readerIdentity();
    if (port.capture !== capture)
      throw new Error("Original credential capture changed.");
    if (host() !== installed || installed.physicalDeviceRecords !== port)
      throw new Error("Original credential inventory changed.");
  };
  check();
  const request: typeof captured.request = bindOriginal(
    captured.request,
    captured.locks,
  );
  const captureReader: typeof capture = bindOriginal(capture, port);
  return request(CREDENTIAL_LOCK_NAME, { mode: "exclusive" }, async (lock) => {
    check();
    checkRetiredOperationGrant(lock, CREDENTIAL_LOCK_NAME);
    const reader = await captureReader(check);
    const close: typeof reader.close = bindOriginal(reader.close, reader);
    let failure: ErrorOptions | undefined;
    try {
      readerIdentity = captureRetiredDeviceReaderIdentity(reader);
      await refuseRetainedCurrentCredentialData(reader, candidate, check);
      const result = await work(check);
      check();
      await reader.revalidateRoot();
      check();
      return result;
    } catch (cause) {
      failure = { cause };
      throw cause;
    } finally {
      await disposeOriginalCommandData(failure, undefined, [close]);
    }
  });
}
