/**
 * An origin-private file system in memory, for suites that run the real kv,
 * the real travel storage and the real wipe over files they can inspect:
 * `navigator.storage.getDirectory()` answers this root. Files hold what the
 * app wrote, which is sealed under the at-rest key, so a test compares bytes
 * before and after rather than reading them.
 */

import { vi } from "vitest";
import { configureHost } from "../../../host.js";
import { createTestHost } from "../../../test-host.js";
import { webLocksDouble } from "../../__tests__/web-locks-double.js";
import { atRestKeyNow } from "../../at-rest/key.js";

export type FakeFileHandle = {
  isSameEntry(other: FakeFileHandle): Promise<boolean>;
  getFile(): Promise<{ size: number; text(): Promise<string> }>;
  createWritable(): Promise<{
    write(value: string): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }>;
};

export type FakeOpfs = {
  isSameEntry(other: FakeOpfs): Promise<boolean>;
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
  const handles = new Map<string, FakeFileHandle>();
  const root: FakeOpfs = {
    files,
    async isSameEntry(other) {
      return other === root;
    },
    async getFileHandle(name, options) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException("gone", "NotFoundError");
        files.set(name, "");
        handles.delete(name);
      }
      const prior = handles.get(name);
      if (prior) return prior;
      const handle: FakeFileHandle = {
        async isSameEntry(other) {
          return other === handle;
        },
        async getFile() {
          if (!files.has(name) || handles.get(name) !== handle)
            throw new DOMException("gone", "NotFoundError");
          const text = files.get(name) ?? "";
          return {
            size: new TextEncoder().encode(text).length,
            text: async () => text,
          };
        },
        async createWritable() {
          return {
            async write(value: string) {
              files.set(name, value);
            },
            async close() {},
            async abort() {},
          };
        },
      };
      handles.set(name, handle);
      return handle;
    },
    async removeEntry(name) {
      if (!files.has(name)) throw new DOMException("gone", "NotFoundError");
      files.delete(name);
      handles.delete(name);
    },
    async *keys() {
      for (const name of [...files.keys()]) yield name;
    },
  };
  return root;
}

/** Make `root` the origin's file system until `vi.unstubAllGlobals()`. */
export function installOpfs(root: FakeOpfs): void {
  vi.stubGlobal("navigator", {
    storage: { getDirectory: () => Promise.resolve(root) },
    locks: webLocksDouble(),
  });
  configureHost(createTestHost());
  atRestKeyNow();
}
