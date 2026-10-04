import { DEVICE_IDENTITY_KEY_PATH } from "@opensesame/vault-core";

/**
 * Settings as files. A category's configuration is a set of virtual files;
 * the Form view is drawn from what they parse to, and Settings' source view
 * is a file viewer over the same paths. Neither view owns a copy: a write in
 * either one is a write to the file, through the provider that stores it.
 *
 * A provider decides where its files live — a sealed tomb file, an entry in
 * the sealed vault body, the embedded built-in corpus — and what a valid
 * write is. The viewer knows none of that; it lists, reads, checks, writes
 * and removes by path.
 */

export type FileLanguage = "json" | "yaml" | "toml";

export type VirtualFile = {
  readonly path: string;
  readonly language: FileLanguage;
  /** Shipped with the build (a built-in type): readable, never written. */
  readonly readOnly: boolean;
  /**
   * Why a read-only file is read-only, when it is not part of the build
   * (a listing the service keeps, a record a ceremony changes).
   */
  readonly readOnlyLabel?: string;
  /** Removing it means something (uninstalling a type). */
  readonly removable: boolean;
};

export type FileCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export type FileOutcome =
  | {
      readonly ok: true;
      readonly path: string;
      /** What the write did, when the provider has more to say than "saved". */
      readonly message?: string;
      /** `warn`: applied, but not as durably as asked (this session only). */
      readonly tone?: "ok" | "warn";
      /** The file as stored, when that is not the text that was written. */
      readonly text?: string;
    }
  | { readonly ok: false; readonly message: string };

export type VirtualFileProvider = {
  list(): readonly VirtualFile[];
  read(path: string): Promise<string>;
  /** The refusal a write would meet, without writing. */
  check(path: string, text: string): FileCheck;
  /** Write and return where the file now lives (a new file may be renamed). */
  write(path: string, text: string): Promise<FileOutcome>;
  remove(path: string): Promise<FileOutcome>;
  /** A directory a person may add a file to, and what a new file starts as. */
  readonly creates?: {
    readonly directory: string;
    readonly draftPath: string;
    readonly template: string;
  };
};

/** The directory part of a path, without its trailing slash. */
export function directoryOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/** The file name without its directory. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

const NO_FILE = "No provider keeps this file.";

/**
 * Several providers as one directory listing: a category's own files and
 * those its contributed panels bring. Each path is answered by the provider
 * that lists it; the first provider that `creates` keeps that offer.
 */
export function mergeFileProviders(
  providers: readonly VirtualFileProvider[],
): VirtualFileProvider {
  const owner = (path: string) =>
    providers.find((provider) =>
      provider.list().some((file) => file.path === path),
    ) ?? providers.find((provider) => provider.creates !== undefined);
  const creates = providers.find(
    (provider) => provider.creates !== undefined,
  )?.creates;
  const merged: VirtualFileProvider = {
    list: () => providers.flatMap((provider) => provider.list()),
    read: async (path) => {
      const provider = owner(path);
      if (!provider) throw new Error(NO_FILE);
      return provider.read(path);
    },
    check: (path, text) =>
      owner(path)?.check(path, text) ?? { ok: false, message: NO_FILE },
    write: async (path, text) =>
      (await owner(path)?.write(path, text)) ?? {
        ok: false,
        message: NO_FILE,
      },
    remove: async (path) =>
      (await owner(path)?.remove(path)) ?? { ok: false, message: NO_FILE },
  };
  if (creates === undefined) return merged;
  return { ...merged, creates };
}

const CONCEALED_NAME = baseName(DEVICE_IDENTITY_KEY_PATH);
const CONCEALED = "This file is not shown or changed here.";

/**
 * A path the viewer never lists, reads, checks, writes or removes: the device
 * identity key (ADR 0160 §5). It is a concealed secret, so no provider offers
 * it, and this is the guarantee that none ever does by accident — the name
 * alone is matched, in any directory, however the path is written.
 */
export function isConcealedFilePath(path: string): boolean {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // An undecodable path is matched as written.
  }
  return decoded
    .split(/[\\/]+/)
    .some((segment) => segment.trim().toLowerCase() === CONCEALED_NAME);
}

/** `provider` with every concealed path removed from its listing and refused by name. */
export function withoutConcealedFiles(
  provider: VirtualFileProvider,
): VirtualFileProvider {
  return {
    ...provider,
    list: () =>
      provider.list().filter((file) => !isConcealedFilePath(file.path)),
    read: async (path) => {
      if (isConcealedFilePath(path)) throw new Error(CONCEALED);
      return provider.read(path);
    },
    check: (path, text) =>
      isConcealedFilePath(path)
        ? { ok: false, message: CONCEALED }
        : provider.check(path, text),
    write: async (path, text) =>
      isConcealedFilePath(path)
        ? { ok: false, message: CONCEALED }
        : provider.write(path, text),
    remove: async (path) =>
      isConcealedFilePath(path)
        ? { ok: false, message: CONCEALED }
        : provider.remove(path),
  };
}
