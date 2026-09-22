/** @vitest-environment jsdom */
/**
 * The composition store against the package fixtures: personal-local boots
 * core-only (MODEL-01), a stale draft conflicts (CONSENT-08), a failed
 * durable write publishes nothing (CONSENT-09), emergency disable blocks in
 * memory even when storage refuses (LIFE-01/09), and an invalid managed
 * policy is a core-only plan, not a permissive one (TRUST-08).
 */

import {
  FIXTURE_FACTS,
  FIXTURE_POLICIES,
} from "@opensesame/capability-composition";
import { beforeEach, describe, expect, it } from "vitest";
import {
  NOW,
  approved,
  bootPersonalLocal,
  draftFor,
  durable,
  failures,
  freshRealm,
  invalidRuntimeConfig,
  managedRuntimeConfig,
} from "./__tests__/harness.js";
import { GENERATION_KEY, SELECTION_KEY, vaultSelectionKey } from "./keys.js";
import { compositionStore, storeSeams } from "./store.js";

const PASSKEYS = "vault.passkey-records";

beforeEach(freshRealm);

describe("boot", () => {
  it("MODEL-01: personal-local with no selection resolves core-only", async () => {
    await bootPersonalLocal();
    const snap = compositionStore.getSnapshot();
    expect(snap.status).toBe("ready");
    expect(snap.provenance).toBe("personal-local");
    expect(approved(compositionStore)).toEqual([
      "settings.core",
      "vault.passwords",
    ]);
    expect(snap.plan?.capabilities[PASSKEYS]?.approved).toBe(false);
    expect(snap.lifecycle[PASSKEYS]).toBe("not-selected");
    expect(snap.generation).toBeGreaterThan(0);
    expect(compositionStore.currentLease().generation).toBe(snap.generation);
  });

  it("treats an unparseable persisted selection as absent, with a diagnostic", async () => {
    durable.set(SELECTION_KEY, "{not json");
    await bootPersonalLocal();
    const snap = compositionStore.getSnapshot();
    expect(snap.selection).toBeNull();
    expect(snap.diagnostics.some((d) => d.startsWith(SELECTION_KEY))).toBe(
      true,
    );
    expect(approved(compositionStore)).toEqual([
      "settings.core",
      "vault.passwords",
    ]);
  });

  it("TRUST-08: an invalid managed policy is managed-invalid and core-only", async () => {
    await compositionStore.boot({
      runtimeConfig: invalidRuntimeConfig(),
      vaultId: null,
      facts: { ...FIXTURE_FACTS, now: NOW },
    });
    const snap = compositionStore.getSnapshot();
    expect(snap.status).toBe("managed-invalid");
    expect(snap.plan?.policyValid).toBe(false);
    expect(approved(compositionStore)).toEqual([
      "settings.core",
      "vault.passwords",
    ]);
    const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");
    expect(await compositionStore.commit(draft, receipt)).toEqual({
      status: "refused",
      reason: "managed-invalid",
    });
  });

  it("a managed policy the trust layer rejects is core-only too", async () => {
    storeSeams.reviewManagedPolicy = () => ({
      ok: false,
      diagnostics: ["policy envelope: signature did not verify"],
    });
    await compositionStore.boot({
      runtimeConfig: managedRuntimeConfig(FIXTURE_POLICIES.family),
      vaultId: null,
      facts: { ...FIXTURE_FACTS, now: NOW },
    });
    const snap = compositionStore.getSnapshot();
    expect(snap.status).toBe("managed-invalid");
    expect(snap.provenance).toBe("same-origin-deployment");
    expect(snap.diagnostics).toContain(
      "policy envelope: signature did not verify",
    );
  });
});

describe("commit", () => {
  it("writes durably, then publishes a new generation that aborts the old lease", async () => {
    await bootPersonalLocal();
    const before = compositionStore.getSnapshot();
    const lease = compositionStore.currentLease();
    const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");

    const outcome = await compositionStore.commit(draft, receipt);

    expect(outcome.status).toBe("committed");
    expect(lease.signal.aborted).toBe(true);
    const after = compositionStore.getSnapshot();
    expect(after.generation).toBeGreaterThan(before.generation);
    expect(approved(compositionStore)).toContain(PASSKEYS);
    expect(JSON.parse(durable.get(SELECTION_KEY) ?? "null")).toEqual(draft);
    expect(JSON.parse(durable.get(GENERATION_KEY) ?? "{}").generation).toBe(1);
  });

  it("CONSENT-08: a draft based on a superseded selection conflicts", async () => {
    await bootPersonalLocal();
    const first = draftFor(compositionStore, [PASSKEYS], "r1");
    expect(
      (await compositionStore.commit(first.draft, first.receipt)).status,
    ).toBe("committed");
    // Another tab committed r2 behind our back.
    const other = draftFor(compositionStore, [], "r2");
    durable.set(SELECTION_KEY, JSON.stringify(other.draft));
    durable.set(
      GENERATION_KEY,
      JSON.stringify({ generation: 2, committedAt: NOW }),
    );

    const third = draftFor(compositionStore, [PASSKEYS], "r3");
    const outcome = await compositionStore.commit(third.draft, third.receipt);

    expect(outcome).toEqual({ status: "conflict", reason: "generation" });
    // The store adopted what is actually on disk.
    expect(compositionStore.getSnapshot().selection?.revision).toBe("r2");
    expect(compositionStore.committedGeneration()).toBe(2);
  });

  it("CONSENT-08: reusing the current revision is a conflict, not a no-op", async () => {
    await bootPersonalLocal();
    const first = draftFor(compositionStore, [PASSKEYS], "r1");
    await compositionStore.commit(first.draft, first.receipt);
    const again = draftFor(compositionStore, [], "r1");
    expect(await compositionStore.commit(again.draft, again.receipt)).toEqual({
      status: "conflict",
      reason: "selection-revision",
    });
  });

  it("CONSENT-09: a failed durable write publishes nothing", async () => {
    await bootPersonalLocal();
    const before = compositionStore.getSnapshot();
    const lease = compositionStore.currentLease();
    let notified = 0;
    const unsubscribe = compositionStore.subscribe(() => {
      notified += 1;
    });
    failures.durableWrite = true;
    const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");

    const outcome = await compositionStore.commit(draft, receipt);

    unsubscribe();
    expect(outcome).toEqual({ status: "refused", reason: "storage" });
    expect(notified).toBe(0);
    expect(compositionStore.getSnapshot()).toBe(before);
    expect(lease.signal.aborted).toBe(false);
    expect(approved(compositionStore)).not.toContain(PASSKEYS);
    expect(durable.has(SELECTION_KEY)).toBe(false);
  });

  it("refuses a receipt that does not cover the draft", async () => {
    await bootPersonalLocal();
    const { draft } = draftFor(compositionStore, [PASSKEYS], "r1");
    const { receipt } = draftFor(compositionStore, [], "r1");
    expect(await compositionStore.commit(draft, receipt)).toEqual({
      status: "refused",
      reason: "consent-incomplete",
    });
  });

  it("fails closed without Web Locks", async () => {
    await bootPersonalLocal();
    storeSeams.locks = () => undefined;
    const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");
    expect(await compositionStore.commit(draft, receipt)).toEqual({
      status: "refused",
      reason: "no-serialization",
    });
  });
});

describe("emergencyDisable", () => {
  it("LIFE-01: blocks in memory and aborts the lease before storage answers", async () => {
    await bootPersonalLocal(compositionStore, "personal");
    const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");
    await compositionStore.commit(draft, receipt);
    expect(approved(compositionStore)).toContain(PASSKEYS);
    const lease = compositionStore.currentLease();

    const outcome = await compositionStore.emergencyDisable(PASSKEYS);

    expect(outcome).toEqual({ blockedNow: true, durable: true });
    expect(lease.signal.aborted).toBe(true);
    expect(approved(compositionStore)).not.toContain(PASSKEYS);
    expect(compositionStore.getSnapshot().lifecycle[PASSKEYS]).toBe("disabled");
    expect(
      JSON.parse(durable.get(vaultSelectionKey("personal")) ?? "{}").disabled,
    ).toEqual([PASSKEYS]);
  });

  it("LIFE-09: still blocks when the durable write fails", async () => {
    await bootPersonalLocal(compositionStore, "personal");
    const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");
    await compositionStore.commit(draft, receipt);
    failures.durableWrite = true;
    const lease = compositionStore.currentLease();

    const outcome = await compositionStore.emergencyDisable(PASSKEYS);

    expect(outcome).toEqual({ blockedNow: true, durable: false });
    expect(lease.signal.aborted).toBe(true);
    expect(approved(compositionStore)).not.toContain(PASSKEYS);
    expect(durable.has(vaultSelectionKey("personal"))).toBe(false);
    expect(
      compositionStore
        .getSnapshot()
        .diagnostics.some((d) => d.includes("durable write failed")),
    ).toBe(true);
  });
});

describe("invalidation", () => {
  it("onVaultChange and invalidate bump the generation and abort the lease", async () => {
    await bootPersonalLocal();
    const lease = compositionStore.currentLease();
    compositionStore.onVaultChange("personal");
    expect(lease.signal.aborted).toBe(true);
    const second = compositionStore.currentLease();
    compositionStore.invalidate("vault-lock");
    expect(second.signal.aborted).toBe(true);
    expect(compositionStore.getSnapshot().generation).toBe(
      lease.generation + 2,
    );
  });

  it("revalidate adopts a newer durable commit and re-resolves", async () => {
    await bootPersonalLocal();
    const lease = compositionStore.currentLease();
    const { draft } = draftFor(compositionStore, [PASSKEYS], "r9");
    durable.set(SELECTION_KEY, JSON.stringify(draft));
    durable.set(
      GENERATION_KEY,
      JSON.stringify({ generation: 4, committedAt: NOW }),
    );

    await compositionStore.revalidate("broadcast-hint");

    expect(lease.signal.aborted).toBe(true);
    expect(compositionStore.getSnapshot().selection?.revision).toBe("r9");
    // Selected but never consented in a receipt: still not approved.
    expect(approved(compositionStore)).not.toContain(PASSKEYS);
    expect(compositionStore.getSnapshot().lifecycle[PASSKEYS]).toBe(
      "consent-required",
    );
  });
});
