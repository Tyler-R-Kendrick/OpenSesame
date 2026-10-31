/** Actual existing sealed origin storage DATA. No vault Root or owner permit is issued. */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { host } from "../host.js";
import { originFiles } from "../ports.js";
import { atRestSettled } from "./at-rest/key.js";
import { kvFileName } from "./kv.js";
import {
  captureOriginalOriginDirectoryData,
  captureOriginalOriginDirectoryNamesData,
} from "./origin-file-publication-fixed-receiver-data.js";
import {
  checkPublicationLimit,
  readOriginRecord,
} from "./origin-file-publication-read.js";
import { comparePublishOriginFile } from "./origin-file-publication.js";

function unavailable(): never {
  throw new Error("Original durable origin storage is unavailable.");
}
const actualHost = host;
const actualProvider = originFiles;
const actualKey = atRestSettled;
const actualDirectory = captureOriginalOriginDirectoryData;
const actualNames = captureOriginalOriginDirectoryNamesData;
const actualRead = readOriginRecord;
const actualPublish = comparePublishOriginFile;
const actualName = kvFileName;
const actualHash = sha256;
const actualHex = bytesToHex;
const bindOriginal = Function.prototype.call.bind(Function.prototype.bind);

/** One private browser-host profile couples all captures to the same actual directory and key. */
export function createOriginalOriginStorageProfile() {
  let loading: ReturnType<typeof captureOriginalProfile> | undefined;
  return async (original: () => void) => {
    original();
    loading ??= captureOriginalProfile();
    const profile = await loading;
    original();
    profile.check();
    await profile.revalidateRoot();
    original();
    const { check, accept, close } = originalLifetime(profile, original);
    const revalidateRoot = () =>
      accept(async () => {
        await profile.revalidateRoot();
        check();
      });
    const result = {
      check,
      close,
      revalidateRoot,
      readOriginalStateIdentity: () =>
        accept(async () => {
          await profile.revalidateRoot();
          check();
          return profile.identity;
        }),
      listPhysicalNames: () =>
        accept(async () => {
          await profile.revalidateRoot();
          check();
          const names: string[] = [];
          for await (const name of profile.names.keys()) {
            check();
            profile.names.check();
            if (names.length >= 4096 || name.length > 512) unavailable();
            names.push(name);
          }
          await profile.revalidateRoot();
          check();
          return Object.freeze(names.sort());
        }),
      readRecord: (key: string, bound: number) =>
        accept(async () => {
          checkPublicationLimit("", bound);
          const name = actualName(key);
          const record = await actualRead(
            profile.root,
            name,
            bound,
            check,
            true,
          );
          check();
          await profile.revalidateRoot();
          check();
          return Object.freeze({
            value: record.value,
            physicalName: name,
            ciphertextDigest:
              record.ciphertext === undefined
                ? null
                : actualHex(
                    actualHash(new TextEncoder().encode(record.ciphertext)),
                  ),
          });
        }),
      publish: (
        key: string,
        expected: string | null,
        next: string,
        bound: number,
        extra?: () => void,
      ) =>
        accept(async () => {
          const publicationCheck = () => {
            check();
            extra?.();
          };
          const landed = await actualPublish(
            actualName(key),
            expected,
            next,
            bound,
            publicationCheck,
            profile.root,
          );
          landed();
          publicationCheck();
        }),
    };
    return Object.freeze({
      ...result,
      read: async (key: string, bound: number) =>
        (await result.readRecord(key, bound)).value,
    });
  };
}

async function captureOriginalProfile() {
  const installed = actualHost();
  const provider = actualProvider();
  const key = actualKey();
  if (!provider || !key?.durable) unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(installed, "originFiles");
  const keyPort = installed.atRestKeys;
  const fixedProvider: typeof provider = bindOriginal(provider, installed);
  const check = () => {
    const current = Object.getOwnPropertyDescriptor(installed, "originFiles");
    if (
      actualHost() !== installed ||
      actualProvider() !== provider ||
      actualKey() !== key ||
      installed.atRestKeys !== keyPort ||
      current?.value !== descriptor?.value ||
      current?.get !== descriptor?.get ||
      current?.set !== descriptor?.set
    )
      unavailable();
  };
  check();
  const root = await fixedProvider();
  const directory = actualDirectory(root);
  const names = actualNames(root);
  check();
  directory.check();
  const identity = crypto.randomUUID();
  const revalidateRoot = async () => {
    check();
    directory.check();
    names.check();
    const current = await fixedProvider();
    check();
    directory.check();
    if (!(await directory.same(current))) unavailable();
    check();
    directory.check();
  };
  return Object.freeze({ root, names, identity, check, revalidateRoot });
}

function originalLifetime(
  profile: Awaited<ReturnType<typeof captureOriginalProfile>>,
  original: () => void,
) {
  let accepting = true;
  let count = 0;
  const pending = new Set<Promise<unknown>>();
  const failures: unknown[] = [];
  let closing: Promise<void> | undefined;
  const check = () => {
    original();
    profile.check();
    if (!accepting) unavailable();
  };
  function accept<T>(work: () => Promise<T>): Promise<T> {
    check();
    if (++count > 512) unavailable();
    const task = Promise.resolve().then(work);
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      (cause) => {
        pending.delete(task);
        failures.push(cause);
      },
    );
    return task;
  }
  const close = () => {
    if (closing) return closing;
    accepting = false;
    closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...pending]);
      if (failures.length)
        throw new AggregateError(
          failures,
          "Original origin accepted work failed.",
        );
    });
    void closing.catch(() => {});
    return closing;
  };

  return { check, accept, close };
}
