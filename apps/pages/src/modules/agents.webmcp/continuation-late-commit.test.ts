/** @vitest-environment jsdom */
import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import {
  bootPersonalLocal,
  freshRealm,
} from "@opensesame/app-core/lib/capabilities/__tests__/harness.js";
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { deriveLease } from "@opensesame/app-core/lib/capabilities/lease.js";
import {
  bindLeaseToCapability,
  registerContribution,
} from "@opensesame/app-core/lib/capabilities/registry.js";
import {
  compositionStore,
  storeSeams,
} from "@opensesame/app-core/lib/capabilities/store.js";
import { kvFlush, kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { enqueueVfsWrite } from "@opensesame/app-core/lib/vfs-write-queue.js";
import {
  BODY_PATH,
  readSealedFile,
  tombFileKey,
  vfsSeams,
} from "@opensesame/app-core/lib/vfs.js";
import { VAULT_TOOLS } from "@opensesame/app-core/webmcp/vault-tools.js";
import { createItem, vaultSealBinding } from "@opensesame/vault-core";
import type { WebMcpToolDescriptor } from "@opensesame/webmcp";
import { afterEach, expect, it, vi } from "vitest";
import { tagWebMcpTool } from "../ports-b.js";
import { registerWebMcpScope } from "./registrar.js";

function assertCommitOutcome(
  phase: string,
  bodyBefore: ReturnType<typeof readSealedFile>,
  bodySeals: number,
) {
  if (phase === "accepted_io")
    expect(readSealedFile("personal", BODY_PATH)).not.toEqual(bodyBefore);
  else if (phase === "body_queue") {
    expect(bodySeals).toBe(1);
    expect(
      vaultStore
        .getSnapshot()
        .rawItems?.some((item) => item.name === "Accepted queue anchor"),
    ).toBe(true);
  } else expect(readSealedFile("personal", BODY_PATH)).toEqual(bodyBefore);
}

async function assertSettledRevision(
  before: Awaited<ReturnType<typeof vaultStore.sealedSnapshot>>,
  phase: string,
  accepted: boolean,
) {
  const settled = await vaultStore.sealedSnapshot();
  expect(settled.header.bodyRev).toBe(settled.rev);
  expect(settled.rev).toBe(
    before.rev + (accepted || phase === "body_queue" ? 1 : 0),
  );
  if (!accepted && phase !== "body_queue")
    expect(settled.header).toEqual(before.header);
}

const cleanups = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups.clear();
  vi.restoreAllMocks();
  vaultStore.lock();
  await kvFlush();
  kvForgetAll();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "modelContext");
});
it.each([
  ["lease", "seal"],
  ["scope", "seal"],
  ["lease", "vfs_queue"],
  ["scope", "vfs_queue"],
  ["lease", "body_queue"],
  ["scope", "body_queue"],
  ["lease", "accepted_io"],
  ["scope", "accepted_io"],
])(
  "retains write admission for original %s across %s",
  async (retired, phase) => {
    freshRealm();
    const owner = await persistentBrowserOwner();
    await vaultStore.unlock(owner.password);
    storeSeams.catalog = async () => CAPABILITY_CATALOG;
    const browser = new Map<string, WebMcpToolDescriptor>();
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool: (tool: WebMcpToolDescriptor) => {
          browser.set(tool.name, tool);
        },
      },
    });
    const write = VAULT_TOOLS.find(
      (tool) => tool.name === "opensesame_vault_item_write",
    );
    if (!write) throw new Error("Missing real metadata write tool");
    const offer = async (boot = true) => {
      if (boot) await bootPersonalLocal();
      const lease = deriveLease(compositionStore.currentLease()).lease;
      bindLeaseToCapability(lease, "vault.passwords");
      const tagged = tagWebMcpTool(write);
      registerContribution("webmcp-tool", tagged, lease);
      return registerWebMcpScope(
        "session",
        [tagged],
        new AbortController().signal,
      );
    };
    const oldUnregister = await offer();
    const invoke = (name: string) => {
      const tool = browser.get(write.name);
      if (!tool) throw new Error("Missing registered descriptor");
      return tool.execute({ kind: "note", name });
    };
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const before = await vaultStore.sealedSnapshot();
    const drains: Promise<void>[] = [];
    cleanups.add(async () => {
      release();
      await Promise.allSettled(drains);
    });
    const bodyBefore = readSealedFile("personal", BODY_PATH);
    expect(bodyBefore).not.toBeNull();
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let first = true;
    let bodySeals = 0;
    vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
      const result = await encrypt(...args);
      const algorithm = args[0];
      if (algorithm instanceof Object && "additionalData" in algorithm) {
        const aad = algorithm.additionalData;
        if (
          (ArrayBuffer.isView(aad) || aad instanceof ArrayBuffer) &&
          new TextDecoder().decode(aad) ===
            vaultSealBinding("personal", BODY_PATH)
        ) {
          bodySeals += 1;
          if (first) {
            first = false;
            if (phase !== "accepted_io") entered();
            if (phase === "seal" || phase === "body_queue") await held;
          }
        }
      }
      return result;
    });
    let blocker: Promise<void> | undefined;
    if (phase === "vfs_queue") {
      let admitted!: () => void;
      const admission = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      blocker = enqueueVfsWrite("personal", async () => {
        admitted();
        await held;
      });
      drains.push(blocker);
      await admission;
    }
    if (phase === "accepted_io") {
      const writeRaw = vfsSeams.writeRaw;
      vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (key, value) => {
        const result = await writeRaw(key, value);
        if (key === tombFileKey("personal", BODY_PATH)) {
          entered();
          await held;
        }
        return result;
      });
    }
    let anchor: Promise<void> | undefined;
    let queued!: () => void;
    const queueEntered = new Promise<void>((resolve) => {
      queued = resolve;
    });
    if (phase === "body_queue") {
      anchor = vaultStore.saveItem(createItem("note", "Accepted queue anchor"));
      drains.push(anchor);
      await started;
      const save = vaultStore.saveItem.bind(vaultStore);
      vi.spyOn(vaultStore, "saveItem").mockImplementation((...args) => {
        const result = save(...args);
        if (args[0].name === "Original withdrawn write") queued();
        return result;
      });
    }
    const pending = invoke("Original withdrawn write");
    drains.push(pending.then(() => undefined));
    await started;
    if (phase === "body_queue") await queueEntered;
    if (phase === "vfs_queue" || phase === "body_queue")
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (retired === "lease")
      await compositionStore.emergencyDisable("vault.passwords");
    else oldUnregister();
    const newUnregister = await offer(retired === "lease");
    release();
    await blocker;
    await anchor;
    expect((await pending).isError).toBe(true);
    const accepted = phase === "accepted_io";
    assertCommitOutcome(phase, bodyBefore, bodySeals);
    expect(
      vaultStore
        .getSnapshot()
        .rawItems?.some((item) => item.name === "Original withdrawn write"),
    ).toBe(accepted);
    vaultStore.lock();
    await vaultStore.unlock(owner.password);
    expect(
      vaultStore
        .getSnapshot()
        .rawItems?.some((item) => item.name === "Original withdrawn write"),
    ).toBe(accepted);
    await assertSettledRevision(before, phase, accepted);
    vi.restoreAllMocks();
    expect((await invoke("Fresh admitted write")).isError).not.toBe(true);
    expect(
      vaultStore
        .getSnapshot()
        .rawItems?.some((item) => item.name === "Fresh admitted write"),
    ).toBe(true);
    vaultStore.lock();
    await vaultStore.unlock(owner.password);
    expect(
      vaultStore
        .getSnapshot()
        .rawItems?.some((item) => item.name === "Fresh admitted write"),
    ).toBe(true);
    oldUnregister();
    newUnregister();
  },
);
