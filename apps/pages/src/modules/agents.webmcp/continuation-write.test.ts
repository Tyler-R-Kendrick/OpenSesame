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
import { shareReachSeams } from "@opensesame/app-core/lib/local-share-reach.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { VAULT_TOOLS } from "@opensesame/app-core/webmcp/vault-tools.js";
import type { WebMcpToolDescriptor } from "@opensesame/webmcp";
import { afterEach, expect, it, vi } from "vitest";
import { tagWebMcpTool } from "../ports-b.js";
import { registerWebMcpScope } from "./registrar.js";

afterEach(async () => {
  vi.restoreAllMocks();
  vaultStore.lock();
  await kvFlush();
  kvForgetAll();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "modelContext");
});
it.each(["lease", "scope"])(
  "refuses a registered metadata write before save after its original %s is retired",
  async (retired) => {
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
    const resolveRole = shareReachSeams.resolveCurrentAccessRole;
    let first = true;
    vi.spyOn(shareReachSeams, "resolveCurrentAccessRole").mockImplementation(
      async (tomb) => {
        const role = await resolveRole(tomb);
        if (first) {
          first = false;
          entered();
          await held;
        }
        return role;
      },
    );
    const pending = invoke("Original withdrawn write");
    await started;
    if (retired === "lease")
      await compositionStore.emergencyDisable("vault.passwords");
    else oldUnregister();
    const newUnregister = await offer(retired === "lease");
    release();
    expect((await pending).isError).toBe(true);
    expect(
      vaultStore
        .getSnapshot()
        .rawItems?.some((item) => item.name === "Original withdrawn write"),
    ).toBe(false);
    expect((await invoke("Fresh admitted write")).isError).not.toBe(true);
    expect(
      vaultStore
        .getSnapshot()
        .rawItems?.some((item) => item.name === "Fresh admitted write"),
    ).toBe(true);
    oldUnregister();
    newUnregister();
  },
);
