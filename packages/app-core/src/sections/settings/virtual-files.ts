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
  /** Removing it means something (uninstalling a type). */
  readonly removable: boolean;
};

export type FileCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export type FileOutcome =
  | { readonly ok: true; readonly path: string }
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
