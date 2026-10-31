import { overlapCast } from "@opensesame/os-domain";
import { configureHost, host } from "../host.js";
import { createTestHost } from "../test-host.js";
import { kvFlush, kvForgetAll } from "./kv.js";

export function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixtureRoot() {
  const files = new Map<string, string>();
  const events: string[] = [];
  const hooks = {
    root: async () => {},
    lookup: async (_name: string) => {},
    read: async (_name: string) => {},
    write: async (_name: string) => {},
  };
  return {
    files,
    events,
    hooks,
    async getFileHandle(name: string, options?: { create?: boolean }) {
      await hooks.lookup(name);
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException("absent", "NotFoundError");
        files.set(name, "");
      }
      // Each acquisition deliberately returns a distinct ordinary handle wrapper.
      return {
        async getFile() {
          events.push(`file:${name}`);
          const snapshot = files.get(name) ?? "";
          return {
            size: new TextEncoder().encode(snapshot).length,
            async text() {
              events.push(`read:${name}`);
              await hooks.read(name);
              events.push(`read-end:${name}`);
              return snapshot;
            },
          };
        },
        async createWritable() {
          events.push(`writer:${name}`);
          let staged = files.get(name) ?? "";
          return {
            async write(value: string) {
              events.push(`write:${name}`);
              await hooks.write(name);
              staged = value;
            },
            async close() {
              files.set(name, staged);
              events.push(`close:${name}`);
            },
            async abort() {
              events.push(`abort:${name}`);
            },
          };
        },
      };
    },
    async removeEntry(name: string) {
      files.delete(name);
      events.push(`remove:${name}`);
    },
  };
}
export async function withFixture(
  run: (root: ReturnType<typeof fixtureRoot>) => Promise<void>,
) {
  const prior = host();
  const root = fixtureRoot();
  configureHost(
    createTestHost({
      originFiles: async () => {
        await root.hooks.root();
        return overlapCast(root);
      },
    }),
  );
  kvForgetAll();
  try {
    await run(root);
  } finally {
    await kvFlush();
    kvForgetAll();
    configureHost(prior);
  }
}
