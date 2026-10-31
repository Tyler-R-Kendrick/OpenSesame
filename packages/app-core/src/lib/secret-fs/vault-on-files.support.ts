/**
 * What the vault conformance suites share (ADR 0182): one vault password, a
 * canary value that must never rest in the clear, the way a fresh process is
 * started over a store, and small readers of a directory's tree.
 */
import { createItem } from "@opensesame/vault-core";
import type { VaultItem } from "@opensesame/vault-core";
import { Effect } from "effect";
import { configureHost, host } from "../../host.js";
import { kvForgetAll } from "../kv.js";
import { VaultStore } from "../vault/store.js";
import { forgetOpenLeasesForTest } from "../vault/vault-shared-locks.js";
import { lockAllTombs } from "../vfs.js";
import type { SecretFsError } from "./errors.js";
import type { FilesHarness } from "./files.conformance.js";
import type { SecretFiles } from "./files.js";
import { installFileBackedVfs } from "./install.js";

export const PASSWORD = "correct horse battery staple";
export const MARKER = "S3CR3T-VALUE-THAT-MUST-NEVER-REST-IN-THE-CLEAR";
export const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
export const bytes = (value: string) => new TextEncoder().encode(value);

export type VaultTestProcess = Readonly<{
  newStore: () => VaultStore;
  stop: () => void;
}>;

/** A fresh process whose exit releases every store before its storage ports. */
export async function startProcess(
  files: SecretFiles,
): Promise<VaultTestProcess> {
  lockAllTombs();
  kvForgetAll();
  forgetOpenLeasesForTest();
  const previousHost = host();
  // Each restart is another process, whose Web Locks cannot remain held here.
  configureHost({ ...previousHost, locks: undefined });
  let restore: () => void;
  try {
    restore = await installFileBackedVfs(files);
  } catch (error) {
    configureHost(previousHost);
    throw error;
  }
  const stores: VaultStore[] = [];
  let stopped = false;
  return {
    newStore: () => {
      if (stopped) throw new Error("That test process has ended.");
      const store = new VaultStore();
      stores.push(store);
      return store;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        // A restart models abrupt exit: do not flush or commit queued work.
        for (const store of stores.splice(0)) store.lock();
      } finally {
        restore();
        configureHost(previousHost);
        lockAllTombs();
        kvForgetAll();
        forgetOpenLeasesForTest();
      }
    },
  };
}

export const run = <A>(effect: Effect.Effect<A, SecretFsError>) =>
  Effect.runPromise(effect);

export async function tree(files: SecretFiles): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const path of await run(files.list(""))) {
    out.set(path, (await run(files.read(path))).revision);
  }
  return out;
}

/** The value a secret holds; anything else holds none. */
export function heldValue(item: VaultItem | undefined): string {
  return item?.kind === "secret" ? item.value : "";
}

export function secret(
  name: string,
  value = MARKER,
  folderId: string | null = null,
) {
  const item = createItem("secret", name);
  return { ...item, value, folderId };
}

export type InProcess = (
  body: (
    files: SecretFiles,
    restart: () => Promise<VaultStore>,
    newStore: () => VaultStore,
  ) => Promise<void>,
  wrap?: (files: SecretFiles) => SecretFiles,
) => Promise<void>;

/** Run `body` as one process over a fresh store; `restart` is the next process over the same files. */
export function processOver(make: () => Promise<FilesHarness>): InProcess {
  return async (body, wrap = (files) => files) => {
    const harness = await make();
    let process = await startProcess(wrap(harness.files));
    try {
      await body(
        harness.files,
        async () => {
          process.stop();
          process = await startProcess(harness.files);
          const store = process.newStore();
          await store.unlock(PASSWORD);
          return store;
        },
        () => process.newStore(),
      );
    } finally {
      try {
        process.stop();
      } finally {
        await harness.cleanup?.();
      }
    }
  };
}
