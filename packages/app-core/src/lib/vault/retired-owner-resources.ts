import { host } from "../../host.js";
import { CREDENTIAL_LOCK_NAME } from "../retired-credentials/credential-lock.js";
/** Original physical operation resources and literal lease IO, never owner grants. */
import { captureHostAuthenticationPort } from "./capture-host-authentication-port.js";
import {
  captureRetiredOperationLockData,
  checkRetiredOperationGrant,
} from "./captured-retired-operation-ports.js";
import {
  type OriginalCommandDrainRecorder,
  disposeOriginalCommandData,
  observeOriginalCommandLeaseData,
} from "./original-command-retirement-data.js";
import {
  captureRetiredDeviceReaderIdentity,
  captureRetiredPublicationReaderIdentity,
} from "./retired-owner-reader-identity.js";
const bindOriginal = Function.prototype.call.bind(Function.prototype.bind);
export function captureRetiredOwnerResources(
  tomb: string,
  original: () => void,
  drainFailed?: OriginalCommandDrainRecorder,
) {
  const installed = host();
  const auth = installed.physicalVaultAuthentication;
  const device = installed.physicalDeviceRecords;
  const publication = installed.physicalVaultPublication;
  const catalogue = installed.physicalCurrentCredentialCatalogue;
  if (!auth || !device || !publication || !catalogue)
    throw new Error("Original local vault security storage is unavailable.");
  const authCapture = auth.capture;
  const deviceCapture = device.capture;
  const publicationCapture = publication.capture;
  const catalogueCapture = catalogue.capture;
  const locks = captureRetiredOperationLockData(original);
  const request: typeof locks.request = bindOriginal(
    locks.request,
    locks.locks,
  );
  const readerChecks = new Set<() => void>();
  const check = () => {
    locks.check();
    for (const checkReader of readerChecks) checkReader();
    if (
      auth.capture !== authCapture ||
      device.capture !== deviceCapture ||
      publication.capture !== publicationCapture ||
      catalogue.capture !== catalogueCapture ||
      host() !== installed ||
      installed.physicalVaultAuthentication !== auth ||
      installed.physicalDeviceRecords !== device ||
      installed.physicalVaultPublication !== publication ||
      installed.physicalCurrentCredentialCatalogue !== catalogue
    )
      throw new Error("Original local vault security ports changed.");
  };
  const lease = <T>(name: string, work: () => Promise<T>): Promise<T> => {
    check();
    let held: Lock | null = null;
    return observeOriginalCommandLeaseData<T>(
      drainFailed ?? (() => undefined),
      (accepted) =>
        request(name, { mode: "exclusive" }, async (lock) => {
          held = lock;
          return await accepted();
        }),
      async () => {
        check();
        checkRetiredOperationGrant(held, name);
        return await work();
      },
    );
  };
  return Object.freeze({
    auth,
    device,
    recordDrainFailure: drainFailed,
    retainReaderIdentity: (checkReader: () => void) => {
      checkReader();
      readerChecks.add(checkReader);
    },
    publication,
    catalogue,
    check,
    withLeases: <T>(work: () => Promise<T>): Promise<T> =>
      lease(CREDENTIAL_LOCK_NAME, () =>
        lease(`opensesame:vault-body:${tomb}`, work),
      ),
    withBody: <T>(foreign: string, work: () => Promise<T>): Promise<T> =>
      lease(`opensesame:vault-body:${foreign}`, work),
  });
}
export async function withRetiredOwnerReaders<T>(
  resources: ReturnType<typeof captureRetiredOwnerResources>,
  tomb: string,
  work: (
    readers: Readonly<{
      auth: Awaited<ReturnType<typeof resources.auth.capture>>;
      device: Awaited<ReturnType<typeof resources.device.capture>>;
      publication: Awaited<ReturnType<typeof resources.publication.capture>>;
      identity: string;
    }>,
  ) => Promise<T>,
): Promise<T> {
  const close: (() => Promise<void>)[] = [];
  let failure: ErrorOptions | undefined;
  try {
    const auth = await captureHostAuthenticationPort(tomb, resources.check);
    close.push(auth.close);
    const device = await resources.device.capture(resources.check);
    close.push(device.close);
    resources.retainReaderIdentity(captureRetiredDeviceReaderIdentity(device));
    const publication = await resources.publication.capture(
      tomb,
      resources.check,
    );
    close.push(publication.close);
    resources.retainReaderIdentity(
      captureRetiredPublicationReaderIdentity(publication),
    );
    if (!auth.readOriginalStateIdentity || !device.readOriginalStateIdentity)
      throw new Error("Original storage coupling is unavailable.");
    const identity = await auth.readOriginalStateIdentity();
    if (identity !== (await device.readOriginalStateIdentity()))
      throw new Error("Original storage roots differ.");
    resources.check();
    return await work({ auth, device, publication, identity });
  } catch (cause) {
    failure = { cause };
    throw cause;
  } finally {
    await disposeOriginalCommandData(
      failure,
      resources.recordDrainFailure,
      close.reverse(),
    );
  }
}
