/** @vitest-environment jsdom */
/**
 * Dispatch gates (ownership.md §4.2, LIFE-04): a contributed destination or
 * tool is authorized when it is *used*, from the live registration and the
 * current plan — and refused, before any handler runs, once the capability
 * that registered it is disabled, the realm is locked, or the operation is
 * not approved. Each enforcement point is driven through its own entry: the
 * gate functions, the command bar's `executeCommand`, and the WebMCP
 * navigation tool. (The keymap jump and the WebMCP execute wrapper live in
 * apps/pages and are tested there.)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  navigationTool,
  webmcpNavigationSeam,
} from "../../webmcp/navigation.js";
import { executeCommand } from "../command-bar/execute.js";
import { commandPathAuthorized } from "../command-bar/types.js";
import {
  assertNavigationContribution,
  registerContributionForTest,
  resetContributionsForTest,
} from "../contributions.js";
import {
  NOW,
  bootPersonalLocal,
  draftFor,
  durable,
  freshRealm,
} from "./__tests__/harness.js";
import {
  admitSensitiveOperation,
  assertNavigationAuthority,
  assertToolAuthority,
} from "./dispatch.js";
import { GENERATION_KEY } from "./keys.js";
import { deriveLease } from "./lease.js";
import { bindLeaseToCapability, registerContribution } from "./registry.js";
import type { ContributionEntry } from "./runtime-contract.js";
import { compositionStore, storeSeams } from "./store.js";

const PASSKEYS = "vault.passkey-records";
const PASSKEY_OP = "pages.items.passkey.create";
const PATH = "/passkeys";

/** Approve PASSKEYS and hand back a lease bound to it, as the loader does. */
async function approvePasskeys() {
  await bootPersonalLocal();
  const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");
  await compositionStore.commit(draft, receipt);
  const child = deriveLease(compositionStore.currentLease());
  bindLeaseToCapability(child.lease, PASSKEYS);
  return child.lease;
}

/** The operation each test tool is owned by, as the Pages tag would carry it. */
const owners = new Map<string, string>();

function tool(name: string, owner: string): ContributionEntry<"webmcp-tool"> {
  owners.set(name, owner);
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({}),
  };
}

function ownerOf(entry: ContributionEntry<"webmcp-tool">): string | null {
  return owners.get(entry.name) ?? null;
}

function ports() {
  return {
    navigate: vi.fn(),
    copy: async () => "copied" as const,
    items: () => [],
    vaultLocked: () => false,
  };
}

beforeEach(freshRealm);
afterEach(() => {
  resetContributionsForTest();
  webmcpNavigationSeam.navigate = () => {
    throw new Error("router_unavailable");
  };
});

describe("assertNavigationAuthority", () => {
  it("admits a destination its approved capability registered", async () => {
    const lease = await approvePasskeys();
    registerContribution("command-path", { path: PATH, label: "P" }, lease);
    expect(() =>
      assertNavigationAuthority("command-path", (e) => e.path === PATH),
    ).not.toThrow();
  });

  it("refuses a destination no registration holds", async () => {
    await bootPersonalLocal();
    expect(() =>
      assertNavigationAuthority("keymap-jump", (e) => e.key === "p"),
    ).toThrow(/NOT_REGISTERED/);
  });

  it("refuses once the owning capability is emergency-disabled", async () => {
    const lease = await approvePasskeys();
    registerContribution("keymap-jump", { key: "p", path: PATH }, lease);
    await compositionStore.emergencyDisable(PASSKEYS);
    expect(() =>
      assertNavigationAuthority("keymap-jump", (e) => e.key === "p"),
    ).toThrow(/capability denied/);
  });

  it("refuses once the realm is locked", async () => {
    const lease = await approvePasskeys();
    registerContribution("command-path", { path: PATH, label: "P" }, lease);
    compositionStore.invalidate("vault-lock");
    expect(() =>
      assertNavigationAuthority("command-path", (e) => e.path === PATH),
    ).toThrow(/capability denied/);
  });
});

describe("assertToolAuthority", () => {
  it("answers the owner's lease when its operation is approved", async () => {
    const lease = await approvePasskeys();
    registerContribution("webmcp-tool", tool("t", PASSKEY_OP), lease);
    expect(assertToolAuthority("t", PASSKEY_OP, ownerOf)).toBe(lease);
  });

  it("refuses a tool owned by an operation the plan does not approve", async () => {
    const lease = await approvePasskeys();
    registerContribution("webmcp-tool", tool("t", "not.approved"), lease);
    expect(() => assertToolAuthority("t", "not.approved", ownerOf)).toThrow(
      /NOT_APPROVED/,
    );
  });

  it("refuses a tool that names an owner it was not registered with", async () => {
    const lease = await approvePasskeys();
    registerContribution("webmcp-tool", tool("t", PASSKEY_OP), lease);
    expect(() => assertToolAuthority("t", "pages.items.list", ownerOf)).toThrow(
      /NOT_REGISTERED/,
    );
  });

  it("refuses after the owning capability is disabled", async () => {
    const lease = await approvePasskeys();
    registerContribution("webmcp-tool", tool("t", PASSKEY_OP), lease);
    await compositionStore.emergencyDisable(PASSKEYS);
    expect(() => assertToolAuthority("t", PASSKEY_OP, ownerOf)).toThrow(
      /capability denied/,
    );
  });
});

describe("admitSensitiveOperation (LIFE-04 at the call)", () => {
  it("admits under a current lease and a matching durable generation", async () => {
    const lease = await approvePasskeys();
    await expect(
      admitSensitiveOperation(PASSKEY_OP, lease),
    ).resolves.toBeUndefined();
  });

  it("refuses when another tab committed a newer generation", async () => {
    const lease = await approvePasskeys();
    durable.set(
      GENERATION_KEY,
      JSON.stringify({ generation: 99, committedAt: NOW }),
    );
    await expect(admitSensitiveOperation(PASSKEY_OP, lease)).rejects.toThrow(
      /STALE_LEASE/,
    );
  });

  it("fails closed without Web Locks", async () => {
    const lease = await approvePasskeys();
    storeSeams.locks = () => undefined;
    await expect(admitSensitiveOperation(PASSKEY_OP, lease)).rejects.toThrow(
      /NO_SERIALIZATION/,
    );
  });
});

describe("the command bar's section command", () => {
  it("opens a contributed section while its capability is approved", async () => {
    const lease = await approvePasskeys();
    registerContribution("command-path", { path: PATH, label: "P" }, lease);
    const p = ports();
    const outcome = await executeCommand({ action: "navigate", path: PATH }, p);
    expect(outcome.ok).toBe(true);
    expect(p.navigate).toHaveBeenCalledWith(PATH);
  });

  it("refuses without moving once the capability is disabled", async () => {
    const lease = await approvePasskeys();
    registerContribution("command-path", { path: PATH, label: "P" }, lease);
    await compositionStore.emergencyDisable(PASSKEYS);
    const p = ports();
    const outcome = await executeCommand({ action: "navigate", path: PATH }, p);
    expect(outcome.ok).toBe(false);
    expect(p.navigate).not.toHaveBeenCalled();
  });

  it("always opens a core section", async () => {
    await bootPersonalLocal();
    const p = ports();
    await executeCommand({ action: "navigate", path: "/vault" }, p);
    expect(p.navigate).toHaveBeenCalledWith("/vault");
  });
});

describe("the WebMCP navigation tool", () => {
  it("moves to a contributed section while its capability is approved", async () => {
    const lease = await approvePasskeys();
    registerContribution("command-path", { path: PATH, label: "P" }, lease);
    const navigate = vi.fn();
    webmcpNavigationSeam.navigate = navigate;
    await navigationTool.execute({ section: PATH });
    expect(navigate).toHaveBeenCalledWith(PATH);
  });

  it("refuses without moving once the capability is disabled", async () => {
    const lease = await approvePasskeys();
    registerContribution("command-path", { path: PATH, label: "P" }, lease);
    await compositionStore.emergencyDisable(PASSKEYS);
    const navigate = vi.fn();
    webmcpNavigationSeam.navigate = navigate;
    await expect(navigationTool.execute({ section: PATH })).rejects.toThrow();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("commandPathAuthorized", () => {
  it("answers true for a core section and a current contribution", async () => {
    const lease = await approvePasskeys();
    registerContribution("command-path", { path: PATH, label: "P" }, lease);
    expect(commandPathAuthorized("/settings")).toBe(true);
    expect(commandPathAuthorized(PATH)).toBe(true);
  });

  it("answers false once the realm is locked", async () => {
    const lease = await approvePasskeys();
    registerContribution("command-path", { path: PATH, label: "P" }, lease);
    compositionStore.invalidate("vault-lock");
    expect(commandPathAuthorized(PATH)).toBe(false);
  });
});

describe("the test channel", () => {
  it("stands in for a lease only in jsdom suites", async () => {
    await bootPersonalLocal();
    registerContributionForTest("keymap-jump", { key: "q", path: "/q" });
    expect(() =>
      assertNavigationContribution("keymap-jump", (e) => e.key === "q"),
    ).not.toThrow();
    resetContributionsForTest();
    expect(() =>
      assertNavigationContribution("keymap-jump", (e) => e.key === "q"),
    ).toThrow(/NOT_REGISTERED/);
  });

  it("is written by no production source", () => {
    // The gate trusts an injected entry, so nothing that ships may inject.
    const here = dirname(fileURLToPath(import.meta.url));
    const roots = [
      join(here, "../.."),
      join(here, "../../../../../apps/pages/src"),
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "node_modules" && name !== "__tests__") walk(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name) || /test/i.test(name)) continue;
        if (name === "contributions.ts") continue;
        if (readFileSync(path, "utf8").includes("registerContributionForTest("))
          offenders.push(relative(here, path));
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});
