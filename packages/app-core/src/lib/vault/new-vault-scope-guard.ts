/** Empty physical namespace checks run within the actual creation transaction, never cached absence. */
import { host } from "../../host.js";
import { CREDENTIAL_LOCK_NAME } from "../retired-credentials/credential-lock.js";
import {
  captureRetiredOperationLockData,
  checkRetiredOperationGrant,
} from "./captured-retired-operation-ports.js";
import { disposeOriginalCommandData } from "./original-command-retirement-data.js";
import type { PhysicalAuthenticationPort } from "./physical-authentication-port.js";
import type { PhysicalDeviceRecordPort } from "./physical-device-record-port.js";
import { captureRetiredDeviceReaderIdentity } from "./retired-owner-reader-identity.js";
const bindOriginal = Function.prototype.call.bind(Function.prototype.bind);
function memoryOnly() {
  const installed = host();
  if (
    installed.physicalVaultAuthentication ||
    installed.originFiles ||
    installed.physicalDeviceRecords ||
    installed.physicalCurrentCredentialCatalogue ||
    installed.physicalVaultPublication
  )
    throw new Error(
      "Original physical vault authentication is required for creation.",
    );
  return installed;
}

async function requireEmptyOriginalReaders(
  tomb: string,
  capture: PhysicalAuthenticationPort["capture"],
  device: PhysicalDeviceRecordPort,
  original: () => void,
) {
  const reader = await capture(tomb, original);
  const {
    read,
    revalidateRoot,
    check: readerCheck,
    close: readerClose,
    readOriginalStateIdentity: authIdentity,
  } = reader;
  const close: typeof readerClose = bindOriginal(readerClose, reader);
  const readSnapshot: typeof read = bindOriginal(read, reader);
  const revalidate: typeof revalidateRoot = bindOriginal(
    revalidateRoot,
    reader,
  );
  const identity = () => {
    original();
    if (
      reader.read !== read ||
      reader.revalidateRoot !== revalidateRoot ||
      reader.check !== readerCheck ||
      reader.close !== readerClose ||
      reader.readOriginalStateIdentity !== authIdentity
    )
      throw new Error("Original creation reader changed.");
    readerCheck.call(reader);
  };
  const cleanup = [close];
  let failure: ErrorOptions | undefined;
  try {
    identity();
    const captureDevice: typeof device.capture = bindOriginal(
      device.capture,
      device,
    );
    const held = await captureDevice(original);
    cleanup.unshift(bindOriginal(held.close, held));
    const deviceCheck = captureRetiredDeviceReaderIdentity(held);
    const deviceIdentity = held.readOriginalStateIdentity;
    if (!authIdentity || !deviceIdentity)
      throw new Error("Original creation root coupling is unavailable.");
    const authRoot: typeof authIdentity = bindOriginal(authIdentity, reader);
    const deviceRoot: typeof deviceIdentity = bindOriginal(
      deviceIdentity,
      held,
    );
    const coupling = async () => {
      identity();
      deviceCheck();
      const first = await authRoot();
      identity();
      deviceCheck();
      const second = await deviceRoot();
      identity();
      deviceCheck();
      if (first !== second)
        throw new Error("Original creation storage roots differ.");
    };
    await coupling();
    await revalidate();
    identity();
    const snapshot = await readSnapshot();
    identity();
    if (
      snapshot.tomb !== tomb ||
      snapshot.header !== null ||
      snapshot.body !== null
    )
      throw new Error(
        "A vault already exists in this scope. Unlock it before continuing.",
      );
    await revalidate();
    await coupling();
    identity();
  } catch (cause) {
    failure = { cause };
    throw cause;
  } finally {
    await disposeOriginalCommandData(failure, undefined, cleanup);
  }
}
/** Caller retains actual CRED; this owns only the selected BODY read turn, released before publication. */
export async function assertNewVaultScopeEmpty(
  tomb: string,
  original: () => void,
): Promise<void> {
  original();
  const installed = host();
  const port = installed.physicalVaultAuthentication;
  if (!port) {
    memoryOnly();
    return;
  }
  const device = installed.physicalDeviceRecords;
  if (
    !device ||
    !installed.physicalVaultPublication ||
    !installed.physicalCurrentCredentialCatalogue
  )
    throw new Error("Complete original physical creation ports are required.");
  const deviceCapture = device.capture;
  const capture = port.capture;
  const captured = captureRetiredOperationLockData(original);
  const check = () => {
    captured.check();
    if (
      host() !== installed ||
      installed.physicalVaultAuthentication !== port ||
      port.capture !== capture ||
      installed.physicalDeviceRecords !== device ||
      device.capture !== deviceCapture
    )
      throw new Error("Original creation storage changed.");
  };
  const request: typeof captured.request = bindOriginal(
    captured.request,
    captured.locks,
  );
  const captureReader: typeof capture = bindOriginal(capture, port);
  const name = `opensesame:vault-body:${tomb}`;
  await request(name, { mode: "exclusive" }, async (lock) => {
    check();
    checkRetiredOperationGrant(lock, name);
    await requireEmptyOriginalReaders(tomb, captureReader, device, check);
  });
  original();
}
/** Standalone passkey creation producer; scalar creation already retains CRED in its collision guard. */
export async function withNewVaultScopeGuard<T>(
  tomb: string,
  original: () => void,
  work: (check: () => void) => Promise<T>,
): Promise<T> {
  original();
  const installed = host();
  if (!installed.physicalVaultAuthentication) {
    memoryOnly();
    const check = () => {
      original();
      if (host() !== installed)
        throw new Error("Original creation host changed.");
      memoryOnly();
    };
    const result = await work(check);
    check();
    return result;
  }
  const captured = captureRetiredOperationLockData(original);
  const {
    physicalVaultAuthentication: auth,
    physicalDeviceRecords: device,
    originFiles,
    physicalVaultPublication: publication,
    physicalCurrentCredentialCatalogue: catalogue,
  } = installed;
  const check = () => {
    captured.check();
    if (
      host() !== installed ||
      installed.physicalVaultAuthentication !== auth ||
      installed.physicalDeviceRecords !== device ||
      installed.originFiles !== originFiles ||
      installed.physicalVaultPublication !== publication ||
      installed.physicalCurrentCredentialCatalogue !== catalogue
    )
      throw new Error("Original creation producer changed.");
  };
  const request: typeof captured.request = bindOriginal(
    captured.request,
    captured.locks,
  );
  return request(CREDENTIAL_LOCK_NAME, { mode: "exclusive" }, async (lock) => {
    check();
    checkRetiredOperationGrant(lock, CREDENTIAL_LOCK_NAME);
    await assertNewVaultScopeEmpty(tomb, check);
    const result = await work(check);
    check();
    return result;
  });
}
