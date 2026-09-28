import * as activityLog from "@opensesame/app-core/lib/activity-log.js";
import type { ActivityEvent } from "@opensesame/app-core/lib/activity-log.js";
import { defaultPrefs } from "@opensesame/app-core/lib/vault/prefs.js";
import type { VaultState } from "@opensesame/app-core/lib/vault/store.js";
/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { useActivityEvents } from "./use-activity.js";

const originalVault = vaultHooksSeams.useVault;

function vault(tomb: string): VaultState {
  return {
    status: "unlocked",
    tomb,
    guest: false,
    header: null,
    items: [],
    folders: [],
    prefs: defaultPrefs,
    lockedOutUntil: null,
    failedAttempts: 0,
    awaitingSecondStep: false,
    durable: true,
  };
}

function event(id: string): ActivityEvent {
  return {
    id,
    occurredAt: "2026-09-01T10:00:00.000Z",
    category: "vault",
    type: "vault.unlocked",
    summary: id,
    outcome: "info",
    targetType: null,
    targetId: null,
    metadata: {},
  };
}

/** A read that resolves only when the test says so. */
function deferred() {
  let resolve: (events: ActivityEvent[]) => void = () => undefined;
  const promise = new Promise<ActivityEvent[]>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vaultHooksSeams.useVault = originalVault;
});

it("a slow read from the vault before a switch never lands on the new one", async () => {
  const reads = new Map([
    ["vault-a", deferred()],
    ["vault-b", deferred()],
  ]);
  vi.spyOn(activityLog, "listActivityEvents").mockImplementation(
    (tomb: string) => reads.get(tomb)?.promise ?? Promise.resolve([]),
  );
  let current = "vault-a";
  vaultHooksSeams.useVault = () => vault(current);

  const { result, rerender } = renderHook(() => useActivityEvents());
  expect(result.current.events).toBeNull();

  // Switch before vault A's read lands; B's read lands first.
  current = "vault-b";
  rerender();
  await act(async () => reads.get("vault-b")?.resolve([event("b-1")]));
  await waitFor(() =>
    expect(result.current.events?.map((row) => row.id)).toEqual(["b-1"]),
  );

  // A's read finally lands: it must not replace B's log.
  await act(async () => reads.get("vault-a")?.resolve([event("a-1")]));
  expect(result.current.tomb).toBe("vault-b");
  expect(result.current.events?.map((row) => row.id)).toEqual(["b-1"]);
  expect(result.current.busy).toBe(false);
});

it("shows nothing from the previous vault while the new one's read is pending", async () => {
  const pendingB = deferred();
  vi.spyOn(activityLog, "listActivityEvents").mockImplementation(
    (tomb: string) =>
      tomb === "vault-a" ? Promise.resolve([event("a-1")]) : pendingB.promise,
  );
  let current = "vault-a";
  vaultHooksSeams.useVault = () => vault(current);

  const { result, rerender } = renderHook(() => useActivityEvents());
  await waitFor(() =>
    expect(result.current.events?.map((row) => row.id)).toEqual(["a-1"]),
  );

  current = "vault-b";
  rerender();
  expect(result.current.tomb).toBe("vault-b");
  expect(result.current.events).toBeNull();

  await act(async () => pendingB.resolve([event("b-1")]));
  await waitFor(() =>
    expect(result.current.events?.map((row) => row.id)).toEqual(["b-1"]),
  );
});
