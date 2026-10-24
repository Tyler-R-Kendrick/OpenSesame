/** @vitest-environment jsdom */
/**
 * The unlocked shell is keyed to the vault that is open. A guest who presses
 * Add on the authenticator row is walked through a key first, in the same
 * sheet, and then on to the scan (ADR 0091). Setting that key turns the vault
 * from a guest's into an owner's without changing its tomb, so the shell and
 * the sheet in it must stay mounted; another vault still gets a fresh shell.
 */

import { INITIAL_SNAPSHOT } from "@opensesame/app-core/lib/capabilities/store-types.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App, type AppSlots } from "./App.js";
import { shellReadySeams } from "./bindings/shell-ready.js";

const realSeams = { ...shellReadySeams };
const listeners = new Set<() => void>();
const counts = { mounts: 0, unmounts: 0 };
const env = { tomb: "guest", guest: true };

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function useEnv<T>(read: () => T): T {
  return useSyncExternalStore(subscribe, read, read);
}

function publish(next: Partial<typeof env>) {
  act(() => {
    Object.assign(env, next);
    for (const listener of [...listeners]) listener();
  });
}

/** Stands in for Settings › Security: a page with a sheet a row opens. */
function SecurityPage() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    counts.mounts += 1;
    return () => {
      counts.unmounts += 1;
    };
  }, []);
  return open ? (
    <p>sheet open</p>
  ) : (
    <button type="button" onClick={() => setOpen(true)}>
      Add
    </button>
  );
}

const slots: Partial<AppSlots> = {
  hasAuthResponse: () => false,
  useVault: () => ({
    status: "unlocked",
    tomb: useEnv(() => env.tomb),
    guest: useEnv(() => env.guest),
  }),
  useTheme: () => {},
  useSessionGuards: () => {},
  useRouteContributions: () => [],
  useUnlockEffects: () => [],
  useShellWrappers: () => [],
  recoverPendingFederatedLink: () => {},
  AppShell: ({ children }) => <div data-testid="app-shell">{children}</div>,
  UnlockScreen: () => <p>unlock screen stub</p>,
  SettingsSection: SecurityPage,
};

function openSheet() {
  render(
    <MemoryRouter initialEntries={["/settings/security"]}>
      <App slots={slots} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(screen.getByText("sheet open")).toBeTruthy();
}

describe("the shell of the open vault", () => {
  beforeEach(() => {
    counts.mounts = 0;
    counts.unmounts = 0;
    Object.assign(env, { tomb: "guest", guest: true });
    // No plan to wait for: the shell mounts with the vault.
    shellReadySeams.useComposition = () => INITIAL_SNAPSHOT;
    shellReadySeams.activatedGeneration = () => INITIAL_SNAPSHOT.generation;
    shellReadySeams.subscribeActivated = subscribe;
  });

  afterEach(() => {
    cleanup();
    listeners.clear();
    Object.assign(shellReadySeams, realSeams);
  });

  it("keeps the sheet open when a guest's vault gains its first key", () => {
    openSheet();
    publish({ guest: false });
    expect(screen.getByText("sheet open")).toBeTruthy();
    expect(counts).toEqual({ mounts: 1, unmounts: 0 });
  });

  it("starts a fresh shell when another vault opens", () => {
    openSheet();
    publish({ tomb: "personal", guest: false });
    expect(screen.queryByText("sheet open")).toBeNull();
    expect(counts).toEqual({ mounts: 2, unmounts: 1 });
  });

  it("starts a fresh shell when a guest session opens on the same tomb", () => {
    Object.assign(env, { guest: false });
    openSheet();
    publish({ guest: true });
    expect(screen.queryByText("sheet open")).toBeNull();
    expect(counts).toEqual({ mounts: 2, unmounts: 1 });
  });
});
