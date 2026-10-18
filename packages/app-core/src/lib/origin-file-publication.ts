/** Cooperative-lock physical publication; OPFS offers no multi-record CAS. */
import { host } from "../host.js";
import { originFiles } from "../ports.js";
import { atRestReady, atRestSettled } from "./at-rest/key.js";
import { sealOriginFile } from "./at-rest/origin-files.js";
import {
  type OriginalOriginDirectoryData,
  type OriginalOriginFileData,
  type OriginalOriginStreamAbortData,
  type OriginalOriginStreamData,
  captureOriginalOriginDirectoryData,
  captureOriginalOriginFileData,
  captureOriginalOriginStreamAbortData,
  captureOriginalOriginStreamData,
} from "./origin-file-publication-fixed-receiver-data.js";
import {
  type OriginRecord,
  checkPublicationLimit,
  readOriginRecord,
  removeOwnEmptyPlaceholder,
} from "./origin-file-publication-read.js";
import { haltedWriteError, storageWritesHalted } from "./storage-halt.js";
const bindOriginal = Function.prototype.call.bind(Function.prototype.bind);
type OriginalOriginDirectoryCaptureData = {
  current?: OriginalOriginDirectoryData;
};
function originalOriginProviderChanged(
  current: PropertyDescriptor | undefined,
  descriptor: PropertyDescriptor | undefined,
) {
  return (
    current?.value !== descriptor?.value ||
    current?.get !== descriptor?.get ||
    current?.set !== descriptor?.set
  );
}
async function capturePhysicalPublication(
  original: () => void,
  originalRoot: FileSystemDirectoryHandle | undefined,
  validate: () => void,
) {
  const installed = host();
  const provider = originFiles();
  const fixedProvider: typeof provider = provider
    ? bindOriginal(provider, installed)
    : undefined;
  const descriptor = Object.getOwnPropertyDescriptor(installed, "originFiles");
  const keyPort = installed.atRestKeys;
  const supplied = originalRoot
    ? captureOriginalOriginDirectoryData(originalRoot)
    : undefined;
  const capturedDirectory: OriginalOriginDirectoryCaptureData = {};
  let key = atRestSettled();
  const check = () => {
    original();
    supplied?.check();
    capturedDirectory.current?.check();
    if (storageWritesHalted()) throw haltedWriteError();
    const current = Object.getOwnPropertyDescriptor(installed, "originFiles");
    if (
      host() !== installed ||
      originalOriginProviderChanged(current, descriptor) ||
      installed.atRestKeys !== keyPort ||
      (key && atRestSettled() !== key)
    )
      throw new Error("Original physical storage context changed.");
  };
  check();
  validate();
  if (!provider || !fixedProvider)
    throw new Error("Persistent guarded storage is unavailable.");
  key = await atRestReady();
  check();
  if (!key.durable)
    throw new Error("Persistent guarded storage is unavailable.");
  const root = await fixedProvider();
  const directory = captureOriginalOriginDirectoryData(root);
  capturedDirectory.current = directory;
  check();
  const revalidateOriginalRoot = async () => {
    check();
    if (!supplied) return;
    const same = await supplied.same(root);
    check();
    if (!same) throw new Error("Original publication directory changed.");
  };
  await revalidateOriginalRoot();
  const retained = directory;
  const revalidateRoot = async () => {
    check();
    const currentProvider = originFiles();
    if (currentProvider !== provider)
      throw new Error("Original physical storage context changed.");
    const currentRoot = await fixedProvider();
    check();
    const same = await retained.same(currentRoot);
    check();
    if (!same) throw new Error("Original physical storage context changed.");
  };
  return {
    directory: retained,
    key,
    check,
    revalidateRoot,
    revalidateOriginalRoot,
  };
}
type UnclosedPublication = Readonly<{
  stream: OriginalOriginStreamData | null;
  acceptedAbort: OriginalOriginStreamAbortData | null;
  predecessor: FileSystemFileHandle | null;
  directory: OriginalOriginDirectoryData;
  name: string;
  entry: OriginalOriginFileData | null;
  error: unknown;
}>;
async function abortUnclosedPublication(
  failed: UnclosedPublication,
): Promise<never> {
  const { stream, acceptedAbort, predecessor, directory, name, entry, error } =
    failed;
  const failures = [error];
  if (acceptedAbort) {
    try {
      if (stream) stream.check();
      else acceptedAbort.check();
    } catch (identityError) {
      failures.push(identityError);
    }
    try {
      // Retire the original accepted stream even if its public abort entry was replaced.
      await acceptedAbort.abort(error);
      if (stream) stream.check();
      else acceptedAbort.check();
    } catch (abortError) {
      failures.push(abortError);
    }
  }
  if (predecessor === null && entry) {
    try {
      await removeOwnEmptyPlaceholder(
        directory.receiver,
        name,
        entry.receiver,
        directory,
        entry,
      );
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
  }
  if (failures.length > 1)
    throw new AggregateError(failures, "Guarded publication cleanup failed.");
  throw error;
}
async function confirmPublishedRecord(
  root: FileSystemDirectoryHandle,
  name: string,
  next: string,
  maxBytes: number,
  check: () => void,
  revalidateRoot: () => Promise<void>,
): Promise<void> {
  const published = await readOriginRecord(root, name, maxBytes, check);
  check();
  await revalidateRoot();
  check();
  if (published.value !== next)
    throw new Error("Storage publication readback failed.");
}
async function confirmPredecessorEntry(
  directory: OriginalOriginDirectoryData,
  name: string,
  before: OriginRecord,
  entry: OriginalOriginFileData,
  expected: string | null,
  maxBytes: number,
  check: () => void,
): Promise<void> {
  const current = await readOriginRecord(
    directory.receiver,
    name,
    maxBytes,
    check,
    false,
    before.handle === null ? entry : undefined,
  );
  check();
  if (!current.handle || !(await entry.same(current.handle)))
    throw new Error("Storage entry changed.");
  check();
  current.entry?.check();
  const ownEmpty = before.handle === null && current.value === "";
  if (current.value !== expected && !ownEmpty)
    throw new Error("Storage record changed.");
  check();
}
/** Close may commit and reject as stale; no memory fallback or rollback after close starts. */
export async function comparePublishOriginFile(
  name: string,
  expected: string | null,
  next: string,
  maxBytes: number,
  original: () => void,
  originalRoot?: FileSystemDirectoryHandle,
): Promise<() => void> {
  const captured = await capturePhysicalPublication(
    original,
    originalRoot,
    () => {
      checkPublicationLimit(next, maxBytes);
      if (expected !== null) checkPublicationLimit(expected, maxBytes);
    },
  );
  const { directory, key, revalidateRoot } = captured;
  const root = directory.receiver;
  let entry: OriginalOriginFileData | null = null;
  let stream: OriginalOriginStreamData | null = null;
  let acceptedAbort: OriginalOriginStreamAbortData | null = null;
  const check = () => {
    captured.check();
    entry?.check();
    stream?.check();
  };
  check();
  await revalidateRoot();
  check();
  await captured.revalidateOriginalRoot();
  check();
  const before = await readOriginRecord(root, name, maxBytes, check);
  entry = before.entry;
  check();
  if (before.value !== expected) throw new Error("Storage record changed.");
  let closeStarted = false;
  try {
    if (!entry) {
      const handle = await directory.get(name, { create: true });
      entry = captureOriginalOriginFileData(handle);
    }
    check();
    const writable = await entry.create();
    acceptedAbort = captureOriginalOriginStreamAbortData(writable);
    stream = captureOriginalOriginStreamData(writable, acceptedAbort);
    check();
    await stream.write(sealOriginFile(key, name, next));
    check();
    await revalidateRoot();
    check();
    await confirmPredecessorEntry(
      directory,
      name,
      before,
      entry,
      expected,
      maxBytes,
      check,
    );
    check();
    closeStarted = true;
    await stream.close();
    check();
    await confirmPublishedRecord(
      root,
      name,
      next,
      maxBytes,
      check,
      revalidateRoot,
    );
    check();
    return check;
  } catch (error) {
    if (closeStarted) throw error;
    return abortUnclosedPublication({
      stream,
      acceptedAbort,
      predecessor: before.handle,
      directory,
      name,
      entry,
      error,
    });
  }
}
