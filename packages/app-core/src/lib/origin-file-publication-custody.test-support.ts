/** Actual device-key/native File fixture; OPFS and stream delivery are explicit API doubles. */
import { overlapCast } from "@opensesame/os-domain";
import { z } from "zod";
import { type Host, configureHost, host } from "../host.js";
import { createTestHost } from "../test-host.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";

type StreamDouble = {
  write: (value: FileSystemWriteChunkType) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
};
type HandleDouble = {
  getFile: () => Promise<File>;
  createWritable: () => Promise<StreamDouble>;
  isSameEntry: (other: FileSystemHandle) => Promise<boolean>;
};
type DeliveryState = {
  phase: string;
  handle?: HandleDouble;
  stream?: StreamDouble;
  file?: File;
  aborted: number;
  closed: number;
  failWrite: boolean;
};
const sealedWire = z.string();
function makeStream(
  files: Map<string, string>,
  path: string,
  state: DeliveryState,
): StreamDouble {
  let pending: string | undefined;
  return {
    async write(value) {
      if (state.failWrite) throw new Error("Actual own write refused.");
      const wire = sealedWire.safeParse(value);
      if (!wire.success) throw new Error("Expected sealed wire.");
      pending = wire.data;
      state.phase = "write";
    },
    async close() {
      if (pending !== undefined) files.set(path, pending);
      state.closed += 1;
      state.phase = "closed";
    },
    async abort() {
      pending = undefined;
      state.aborted += 1;
    },
  };
}
let prior: Host | undefined;
export const name = "opensesame-pages-custody.json";
export function fixture(configureStream?: (stream: StreamDouble) => void) {
  prior ??= host();
  const files = new Map<string, string>();
  const handles = new Map<string, HandleDouble>();
  const state: DeliveryState = {
    phase: "start",
    aborted: 0,
    closed: 0,
    failWrite: false,
  };
  const root = {
    async getFileHandle(path: string, options?: FileSystemGetFileOptions) {
      if (!files.has(path)) {
        if (!options?.create) throw new DOMException("gone", "NotFoundError");
        files.set(path, "");
      }
      let handle = handles.get(path);
      if (!handle) {
        const current: HandleDouble = {
          async getFile() {
            const file = new File([files.get(path) ?? ""], path);
            state.file = file;
            state.phase = "file";
            return file;
          },
          async createWritable() {
            const stream = makeStream(files, path, state);
            state.stream = stream;
            state.phase = "stream";
            configureStream?.(stream);
            return stream;
          },
          async isSameEntry(other) {
            return Object.is(other, current);
          },
        };
        handle = current;
        handles.set(path, handle);
      }
      state.handle = handle;
      state.phase = "handle";
      return handle;
    },
    async isSameEntry(other: FileSystemHandle) {
      return other === directory;
    },
    async removeEntry(path: string) {
      files.delete(path);
    },
  };
  const directory: FileSystemDirectoryHandle = overlapCast(root);
  const installed = createTestHost({
    originFiles: async () => {
      state.phase = "root";
      return directory;
    },
  });
  configureHost(installed);
  forgetAtRestKeyForTest();
  return { root, directory, state, files, installed };
}
export function restoreOriginPublicationFixture() {
  try {
    if (prior) {
      configureHost(prior);
      prior = undefined;
    }
  } finally {
    forgetAtRestKeyForTest();
  }
}
