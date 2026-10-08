/** @vitest-environment jsdom */

/**
 * The Ask/Search list follows the same gate as the tutorial library: a
 * question whose capability is not approved, whose required state does not
 * hold, or whose screen is somewhere else, is not offered here.
 */

import { INITIAL_SNAPSHOT } from "@opensesame/app-core/lib/capabilities/store-types.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import type { VaultState } from "@opensesame/app-core/lib/vault/store-state.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { EffectivePlan } from "@opensesame/capability-composition";
import { fakeAgentAlwaysUnavailable } from "@opensesame/support-agent";
import type { RecoveryCodesRecord, VaultHeader } from "@opensesame/vault-core";
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { profilePlan } from "../../lib/capabilities/__tests__/vault-profiles.js";
import { mount, openPanel, resetSupport } from "./support-test-harness.js";

const HIDDEN = [
  "How do I set a duress code?",
  "How do I protect my vaults when I travel?",
  "Which of my passwords are weak or reused?",
  "Save the recovery codes",
  "Install a vault item type",
] as const;

const readPlan = compositionStore.getSnapshot;
let minimal: EffectivePlan;

beforeAll(() => {
  minimal = profilePlan("minimal-local");
});

afterEach(() => {
  compositionStore.getSnapshot = readPlan;
  vi.restoreAllMocks();
  resetSupport();
});

function showPlan(plan: EffectivePlan | null): void {
  const snapshot = {
    ...INITIAL_SNAPSHOT,
    status: "ready" as const,
    plan,
  };
  compositionStore.getSnapshot = () => snapshot;
}

function approve(plan: EffectivePlan, ids: readonly string[]): EffectivePlan {
  const capabilities = { ...plan.capabilities };
  for (const id of ids) {
    const state = capabilities[id];
    if (!state) throw new Error(`missing capability ${id}`);
    capabilities[id] = { ...state, approved: true };
  }
  return { ...plan, capabilities };
}

async function titles(route: string): Promise<readonly string[]> {
  const user = userEvent.setup();
  mount(fakeAgentAlwaysUnavailable("no_local_model"), "none", null, route);
  const { panel } = await openPanel(user);
  const questions = within(panel).getByRole("region", { name: "Questions" });
  return within(questions)
    .getAllByRole("button")
    .map((button) => button.textContent ?? "");
}

describe("help questions follow the installed plan", () => {
  it("leaves travel, duress, health, recovery and item types off a minimal vault", async () => {
    showPlan(minimal);
    for (const route of ["/vault", "/settings/danger"]) {
      resetSupport();
      const listed = await titles(route);
      for (const title of HIDDEN) {
        expect(listed, `${route}: ${title}`).not.toContain(title);
      }
      expect(listed).toContain("Where do I lock the vault?");
      expect(listed).toContain("How do I tell whether OpenSesame is healthy?");
    }
  });

  it("hides the same questions when no plan has resolved", async () => {
    const listed = await titles("/settings/danger");
    for (const title of HIDDEN) expect(listed).not.toContain(title);
    expect(listed).toContain("Where do I lock the vault?");
  });

  it("lists weak or reused passwords once security checks are approved", async () => {
    showPlan(approve(minimal, ["vault.security-checks"]));
    const listed = await titles("/vault");
    expect(listed).toContain("Which of my passwords are weak or reused?");
    expect(listed).not.toContain("Install a vault item type");
  });

  it("lists item-type install once a record capability is approved", async () => {
    showPlan(approve(minimal, ["vault.passkey-records"]));
    const listed = await titles("/vault");
    expect(listed).toContain("Install a vault item type");
    expect(listed).not.toContain("Which of my passwords are weak or reused?");
  });

  it("lists recovery codes once this vault has made them", async () => {
    showPlan(minimal);
    const snapshot = vaultStore.getSnapshot();
    const header: VaultHeader = snapshot.header ?? {
      v: 1,
      createdAt: "2026-10-08T00:00:00.000Z",
    };
    const recovery = {
      codesWrap: { ivB64: "aXY=", ctB64: "Y3Q=" },
      total: 1,
      since: "2026-10-08T00:00:00.000Z",
    } satisfies RecoveryCodesRecord;
    vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
      ...snapshot,
      header: {
        ...header,
        unlocks: { ...header.unlocks, recovery },
      },
    } satisfies VaultState);
    const listed = await titles("/vault");
    expect(listed).toContain("Save the recovery codes");
  });

  it("lists duress and travel on Security, where those panels are drawn", async () => {
    showPlan(minimal);
    const listed = await titles("/settings/security");
    expect(listed).toContain("How do I set a duress code?");
    expect(listed).toContain("How do I protect my vaults when I travel?");
    expect(listed).not.toContain("Which of my passwords are weak or reused?");
  });
});
