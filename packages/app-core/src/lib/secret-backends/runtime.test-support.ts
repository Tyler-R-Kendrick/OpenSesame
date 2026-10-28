import { vi } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { atRestReady } from "../at-rest/key.js";
import { kvFlush, kvForgetAll } from "../kv.js";
import { vaultStore } from "../vault/store.js";
import { vfsFlush } from "../vfs.js";
import { secretBackendDraft } from "./presets.js";
import { bindSecretBackendTransport } from "./transport.js";
import type { SecretBackendFetch } from "./types.js";

interface RuntimeEntryIdentity {
  isSameEntry(other: RuntimeEntryIdentity): Promise<boolean>;
}

export const runtimePassword = "correct horse battery staple runtime fixture";
export const ledgerFile =
  "opensesame-pages-opensesame.self-hosted-connectors.v1.json";
export function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function runtimeFixture() {
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  vaultStore.lock();
  await vfsFlush();
  await kvFlush();
  kvForgetAll();
  const files = new Map<string, string>();
  const created = new Set<string>();
  let atomicWrite: (() => Promise<void>) | undefined;
  const root = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name) && !created.has(name) && !options?.create)
        throw new DOMException("Missing", "NotFoundError");
      if (!files.has(name)) {
        created.add(name);
      }
      const handle = {
        __opfsName: name,
        async isSameEntry(other: RuntimeEntryIdentity): Promise<boolean> {
          return "__opfsName" in other && other.__opfsName === name;
        },
        async getFile() {
          if (!files.has(name) && !created.has(name))
            throw new DOMException("Missing", "NotFoundError");
          return {
            size: new TextEncoder().encode(files.get(name) ?? "").length,
            text: async () => files.get(name) ?? "",
          };
        },
        async createWritable() {
          let staged = files.get(name) ?? "";
          return {
            async write(value: string) {
              if (name === ledgerFile) await atomicWrite?.();
              staged = value;
            },
            async close() {
              files.set(name, staged);
              created.delete(name);
            },
            async abort() {},
          };
        },
      };
      return handle;
    },
    async isSameEntry(other: RuntimeEntryIdentity): Promise<boolean> {
      return other === root;
    },
    async *keys() {
      yield* new Set([...files.keys(), ...created]);
    },
    async removeEntry(name: string) {
      files.delete(name);
      created.delete(name);
    },
  };
  vi.stubGlobal("navigator", {
    storage: { getDirectory: async () => root },
    locks: webLocksDouble(),
  });
  configureHost(createTestHost());
  await atRestReady();
  vaultStore.loadActiveProjectScope();
  await vaultStore.create(runtimePassword);
  const fetcher = vi.fn<SecretBackendFetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/vaults/vault"))
      return Response.json({ id: "vault", name: "Backups" });
    if (url.endsWith("/v1/vaults/vault/items")) return Response.json([]);
    return new Response(null, { status: 404 });
  });
  const unbind = bindSecretBackendTransport({
    fetch: fetcher,
    assertCurrent: () => {},
    signal: new AbortController().signal,
  });
  return {
    files,
    fetcher,
    beforeAtomicWrite(action?: () => Promise<void>) {
      atomicWrite = action;
    },
    async close() {
      await vaultStore.flushPendingWrites();
      await vfsFlush();
      vaultStore.lock();
      await vfsFlush();
      await kvFlush();
      unbind();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      configureHost(createTestHost());
    },
  };
}
export function remoteDraft() {
  return {
    ...secretBackendDraft("1password"),
    mode: "onepassword-connect" as const,
    baseUrl: "https://connect.example.com",
    vaultId: "vault",
    token: "runtime-connect-token-fixture",
  };
}
