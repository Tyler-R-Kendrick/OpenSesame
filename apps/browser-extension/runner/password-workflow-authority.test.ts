import { webcrypto } from "node:crypto";
// @vitest-environment jsdom
import {
  holdGenuineRead,
  persistentBrowserOwner,
  persistentManagementBridge,
} from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { startSecurityPanel } from "@opensesame/app-core/browser/security/bootstrap.js";
import { deferred } from "@opensesame/app-core/browser/security/management.fixture.js";
import { configureHost } from "@opensesame/app-core/host.js";
import { kvFileName, kvFlush } from "@opensesame/app-core/lib/kv.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  HEADER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
} from "@opensesame/app-core/lib/vfs.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { expect, it, vi } from "vitest";
import { createGuardedHealthClient, readGuardedHealth } from "./guarded-health";
import { createWorkflowHandoff } from "./password-workflow-handoff";
import { clickSecurityAction } from "./test-support/security-action";

function input(root: HTMLElement, label: string) {
  const found = [...root.querySelectorAll("label")]
    .find((node) => node.textContent === label)
    ?.querySelector("input");
  if (!(found instanceof HTMLInputElement)) throw new Error(`Missing ${label}`);
  return found;
}
function button(root: HTMLElement, name: string) {
  const found = [...root.querySelectorAll("button")].find(
    (node) => node.textContent === name,
  );
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}
async function fixture() {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("CryptoKey", webcrypto.CryptoKey);
  const owner = await persistentBrowserOwner();
  const bridge = persistentManagementBridge();
  const root = document.createElement("section");
  let real = false;
  const security = startSecurityPanel(root, bridge.runtime, (allowed) => {
    real = allowed && security.permit() !== undefined;
  });
  const opened: string[] = [];
  const handoff = createWorkflowHandoff(
    security,
    () => real,
    async ({ url }) => {
      opened.push(url);
    },
  );
  let unlockAttempt = 0;
  async function unlock(password: string) {
    unlockAttempt += 1;
    input(root, "Vault password").value = password;
    await clickSecurityAction(button(root, "Unlock vault"));
    await vi.waitFor(() =>
      expect(
        root.textContent,
        `Actual panel unlock ${unlockAttempt}`,
      ).toContain("Vault open"),
    );
  }
  await security.ready;
  return {
    owner,
    root,
    security,
    handoff,
    opened,
    unlock,
    async close() {
      bridge.close();
      await bridge.drain();
      vaultStore.lock();
      await kvFlush();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      configureHost(createTestHost());
    },
  };
}
it("opens only from its genuine real worker session, rejects synthetic and revoked sessions, and admits fresh owner recovery", async () => {
  const f = await fixture();
  const { owner, root, security, handoff, opened, unlock } = f;
  let release = () => {};
  try {
    await expect(handoff("inventory")).rejects.toThrow();
    await unlock(owner.password);
    await expect(handoff("inventory")).resolves.toBeUndefined();
    expect(opened).toEqual([
      "https://tyler-r-kendrick.github.io/OpenSesame/vault?workflow=password",
    ]);
    await expect(handoff("https://attacker.example")).rejects.toThrow(
      "Unknown vault task",
    );
    await vi.waitFor(() =>
      expect(root.textContent).toContain("Retired credential traps"),
    );
    input(root, "Current vault password").value = owner.password;
    input(root, "Retired vault password").value =
      "retired-workflow-synthetic-fixture";
    const response = root.querySelector(
      'select[aria-label="Retired password response"]',
    );
    const risk = root.querySelector('input[type="checkbox"]');
    if (
      !(response instanceof HTMLSelectElement) ||
      !(risk instanceof HTMLInputElement)
    )
      throw new Error("Missing genuine enrollment controls");
    response.value = "synthetic_decoy";
    risk.checked = true;
    await clickSecurityAction(button(root, "Enroll retired password"));
    await vi.waitFor(() =>
      expect(root.textContent).toContain("Retired credential trap enrolled."),
    );
    button(root, "Lock vault").click();
    await unlock("retired-workflow-synthetic-fixture");
    await expect(handoff("create")).rejects.toThrow();
    expect(opened).toHaveLength(1);
    button(root, "Lock vault").click();
    await unlock(owner.password);
    await expect(handoff("requests")).resolves.toBeUndefined();
    expect(opened).toHaveLength(2);
    const held = holdGenuineRead(
      owner.root,
      kvFileName(tombFileKey(PERSONAL_TOMB, HEADER_PATH)),
    );
    release = held.release;
    const stale = handoff("read");
    const rejected = expect(stale).rejects.toThrow();
    let readStarted = false;
    void held.started.then(() => {
      readStarted = true;
    });
    await vi.waitFor(() => expect(readStarted).toBe(true));
    vaultStore.lock();
    held.release();
    await rejected;
    expect(opened).toHaveLength(2);
    await expect(handoff("env-resolve")).rejects.toThrow();
  } finally {
    release();
    await f.close();
  }
});

function transport(heldPath: string | null, check: () => Promise<void>) {
  const started = deferred<void>();
  const resume = deferred<void>();
  const calls: string[] = [];
  const client = createGuardedHealthClient(
    "https://controlled.example",
    check,
    async (resource) => {
      const pathname = new URL(
        resource instanceof Request ? resource.url : String(resource),
      ).pathname;
      calls.push(pathname);
      if (pathname === heldPath) {
        started.finish();
        await resume.promise;
      }
      return new Response(
        JSON.stringify({ resource: "https://controlled.example" }),
        {
          status:
            heldPath === "/.well-known/oauth-protected-resource" ? 404 : 200,
        },
      );
    },
  );
  return {
    client,
    calls,
    started: started.promise,
    release: () => resume.finish(),
  };
}
it("completes the real owner's bounded Host health, daemon and discovery reads", async () => {
  const f = await fixture();
  try {
    await f.unlock(f.owner.password);
    const network = transport(null, f.security.requireProduction);
    const result = await readGuardedHealth(
      f.security.requireProduction,
      async () => "https://controlled.example",
      () => network.client,
    );
    expect(result.health.ok).toBe(true);
    expect(result.daemon.available).toBe(true);
    expect(result.discovery.resource).toBe("https://controlled.example");
    expect(network.calls).toEqual([
      "/health/live",
      "/health",
      "/.well-known/oauth-protected-resource",
    ]);
  } finally {
    await f.close();
  }
});
it.each(["/health/live", "/health", "/.well-known/oauth-protected-resource"])(
  "does not start a later external read when the owner locks while %s is pending",
  async (path) => {
    const f = await fixture();
    const network = transport(path, f.security.requireProduction);
    try {
      await f.unlock(f.owner.password);
      const work = readGuardedHealth(
        f.security.requireProduction,
        async () => "https://controlled.example",
        () => network.client,
      );
      const refused = expect(work).rejects.toThrow();
      await vi.waitFor(() => expect(network.calls).toContain(path));
      vaultStore.lock();
      network.release();
      await refused;
      expect(network.calls).toEqual(
        path === "/health/live"
          ? ["/health/live"]
          : path === "/health"
            ? ["/health/live", "/health"]
            : [
                "/health/live",
                "/health",
                "/.well-known/oauth-protected-resource",
              ],
      );
    } finally {
      network.release();
      await f.close();
    }
  },
);
