/**
 * An origin-private file system in memory, for suites that run the real kv,
 * the real travel storage and the real wipe over files they can inspect:
 * `navigator.storage.getDirectory()` answers this root. Files hold what the
 * app wrote, which is sealed under the at-rest key, so a test compares bytes
 * before and after rather than reading them.
 */

import { vi } from "vitest";

export type FakeFileHandle = {
  getFile(): Promise<{ size: number; text(): Promise<string> }>;
  createWritable(): Promise<{
    write(value: string): Promise<void>;
    close(): Promise<void>;
  }>;
};

export type FakeOpfs = {
  files: Map<string, string>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FakeFileHandle>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncGenerator<string>;
};

export function makeOpfs(): FakeOpfs {
  const files = new Map<string, string>();
  return {
    files,
    async getFileHandle(name, options) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException("gone", "NotFoundError");
        files.set(name, "");
      }
      return {
        async getFile() {
          const text = files.get(name) ?? "";
          return { size: text.length, text: async () => text };
        },
        async createWritable() {
          return {
            async write(value: string) {
              files.set(name, value);
            },
            async close() {},
          };
        },
      };
    },
    async removeEntry(name) {
      if (!files.has(name)) throw new DOMException("gone", "NotFoundError");
      files.delete(name);
    },
    async *keys() {
      for (const name of [...files.keys()]) yield name;
    },
  };
}

/** Make `root` the origin's file system until `vi.unstubAllGlobals()`. */
export function installOpfs(root: FakeOpfs): void {
  vi.stubGlobal("navigator", {
    storage: { getDirectory: () => Promise.resolve(root) },
  });
}
