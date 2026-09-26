/** @vitest-environment jsdom */
/**
 * The unlocked shell mounts once, under the unlocked vault's own generation.
 *
 * Unlocking bumps the composition to `vault:<tomb>`, and the change
 * coordinator revokes the previous generation's routes and wrappers before
 * activating them again. A contributed screen mounted before that pass ends
 * is unmounted by it — for the browser-local consent popup, that closed the
 * relying party's channel (`local_session_closed`). These tests drive the
 * default `useShellReady` through its seams, not a stubbed slot.
 */

import type { RouteContribution } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  type CompositionSnapshot,
  INITIAL_SNAPSHOT,
} from "@opensesame/app-core/lib/capabilities/store-types.js";
import type { EffectivePlan } from "@opensesame/capability-composition";
import { overlapCast } from "@opensesame/os-domain";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useSyncExternalStore } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App, type AppSlots } from "./App.js";
import { shellReadySeams } from "./bindings/shell-ready.js";

const realSeams = { ...shellReadySeams };
const listeners = new Set<() => void>();
const counts = { mounts: 0, unmounts: 0 };
const env = {
  status: "locked",
  snapshot: INITIAL_SNAPSHOT,
  activated: -1,
};

function planFor(vaultId: string | null): EffectivePlan {
  return overlapCast({ identity: { vaultId } });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Every double reads `env` through one subscription, as the real stores do. */
function useEnv<T>(read: () => T): T {
  return useSyncExternalStore(subscribe, read, read);
}

function publish(next: Partial<typeof env>) {
  act(() => {
    Object.assign(env, next);
    for (const listener of [...listeners]) listener();
  });
}

function snapshotAt(
  generation: number,
  vaultId: string | null,
): CompositionSnapshot {
  return { ...INITIAL_SNAPSHOT, generation, plan: planFor(vaultId) };
}

function Consent() {
  useEffect(() => {
    counts.mounts += 1;
    return () => {
      counts.unmounts += 1;
    };
  }, []);
  return <p>consent screen</p>;
}

const consentRoute: RouteContribution = {
  id: "identity.local-iam/authorize",
  path: "/identity/authorize",
  element: Consent,
  framed: false,
  order: 41,
};

const slots: Partial<AppSlots> = {
  hasAuthResponse: () => false,
  useVault: () => ({
    status: useEnv(() => env.status),
    tomb: "personal",
    guest: false,
  }),
  useTheme: () => {},
  useSessionGuards: () => {},
  useRouteContributions: () => [consentRoute],
  useUnlockEffects: () => [],
  useShellWrappers: () => [],
  recoverPendingFederatedLink: () => {},
  AppShell: ({ children }) => <div data-testid="app-shell">{children}</div>,
  UnlockScreen: () => <p>unlock screen stub</p>,
};

function renderConsent() {
  return render(
    <MemoryRouter initialEntries={["/identity/authorize?state=s"]}>
      <App slots={slots} />
    </MemoryRouter>,
  );
}

describe("shell after unlock", () => {
  beforeEach(() => {
    counts.mounts = 0;
    counts.unmounts = 0;
    Object.assign(env, {
      status: "locked",
      snapshot: snapshotAt(1, null),
      activated: 1,
    });
    shellReadySeams.useComposition = () => useEnv(() => env.snapshot);
    shellReadySeams.activatedGeneration = () => env.activated;
    shellReadySeams.subscribeActivated = subscribe;
  });

  afterEach(() => {
    cleanup();
    listeners.clear();
    Object.assign(shellReadySeams, realSeams);
  });

  it("does not mount a contributed screen until the unlocked vault's generation has activated", () => {
    renderConsent();
    expect(screen.getByText("unlock screen stub")).toBeTruthy();

    // The vault opened; the plan on screen is still the locked one.
    publish({ status: "unlocked" });
    expect(screen.queryByText("consent screen")).toBeNull();

    // The vault's generation resolved, and its activation pass is running.
    publish({ snapshot: snapshotAt(2, "personal") });
    expect(screen.queryByText("consent screen")).toBeNull();
    expect(counts.mounts).toBe(0);

    publish({ activated: 2 });
    expect(screen.getByText("consent screen")).toBeTruthy();
    expect(counts).toEqual({ mounts: 1, unmounts: 0 });
  });

  it("keeps the screen mounted through a later generation, and waits again after a lock", () => {
    renderConsent();
    publish({
      status: "unlocked",
      snapshot: snapshotAt(2, "personal"),
      activated: 2,
    });
    expect(counts).toEqual({ mounts: 1, unmounts: 0 });

    // A later change (another tab committed) is answered by the route's own
    // fallbacks, not by tearing the shell down.
    publish({ snapshot: snapshotAt(3, "personal") });
    expect(screen.getByText("consent screen")).toBeTruthy();
    expect(counts).toEqual({ mounts: 1, unmounts: 0 });

    publish({ status: "locked", snapshot: snapshotAt(4, null), activated: 4 });
    expect(screen.getByText("unlock screen stub")).toBeTruthy();
    expect(counts.unmounts).toBe(1);

    publish({ status: "unlocked" });
    expect(screen.queryByText("consent screen")).toBeNull();
    publish({ snapshot: snapshotAt(5, "personal"), activated: 5 });
    expect(counts).toEqual({ mounts: 2, unmounts: 1 });
  });

  it("has nothing to wait for when no plan has resolved", () => {
    env.snapshot = INITIAL_SNAPSHOT;
    env.status = "unlocked";
    renderConsent();
    expect(screen.getByText("consent screen")).toBeTruthy();
  });

  it("mounts anyway once the wait runs out, so a stalled module never blanks the vault", async () => {
    shellReadySeams.maxWaitMs = 20;
    renderConsent();
    // The vault's generation resolved, but its activation pass never ends.
    publish({ status: "unlocked", snapshot: snapshotAt(2, "personal") });
    expect(screen.queryByText("consent screen")).toBeNull();
    await waitFor(() =>
      expect(screen.getByText("consent screen")).toBeTruthy(),
    );
    expect(counts).toEqual({ mounts: 1, unmounts: 0 });
  });
});
