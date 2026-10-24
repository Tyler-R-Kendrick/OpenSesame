/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://pwa.example.test/OpenSesame/"} */
import { File } from "node:buffer";
import { webcrypto } from "node:crypto";
import { configureHost, host } from "@opensesame/app-core/host.js";
import { webLocksDouble } from "@opensesame/app-core/lib/__tests__/web-locks-double.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { DECOY_SCRATCH_TOMB } from "@opensesame/app-core/lib/duress/store/decoy-scratch.js";
import { kvFlush, kvForgetAll, kvGet } from "@opensesame/app-core/lib/kv.js";
import {
  fixture,
  restoreOriginPublicationFixture,
} from "@opensesame/app-core/lib/origin-file-publication-custody.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { PIN_PBKDF2_ITERATIONS } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import {
  GUEST_TOMB,
  HEADER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "@opensesame/app-core/lib/vfs.js";
import { createMemoryStorage } from "@opensesame/app-core/memory-storage.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App, type AppSlots } from "./App.js";
import { unlockCeremonyStore } from "./lib/unlock-ceremony-store.js";
import { UnlockMethodsPanel } from "./sections/settings/UnlockMethodsPanel.js";

const PIN = "48291037"; // The original verify-auth guest PIN, at the actual configured KDF cost.
const slots: Partial<AppSlots> = {
  hasAuthResponse: () => false,
  // Bind App directly to the real publisher; no synthetic vault snapshots.
  useVault: () =>
    useSyncExternalStore(vaultStore.subscribe, vaultStore.getSnapshot),
  useTheme: () => {},
  useSessionGuards: () => {},
  useRouteContributions: () => [],
  useShellWrappers: () => [],
  useUnlockEffects: () => [],
  recoverPendingFederatedLink: () => {},
  AppShell: ({ children }) => <main>{children}</main>,
  SettingsSection: UnlockMethodsPanel,
  UnlockScreen: () => <p>Vault is locked</p>,
};

beforeEach(async () => {
  compositionStore.resetForTest();
  unlockCeremonyStore.reset();
  vaultStore.lock();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  kvForgetAll();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("File", File);
  vi.stubGlobal("navigator", { locks: webLocksDouble(), onLine: true });
  const origin = fixture();
  // The real browser inventory ports require the same complete native provider
  // as originFiles. The custody fixture already owns genuine sealed bytes;
  // add its directory enumeration rather than replacing custody or crypto.
  Object.assign(origin.root, {
    async *keys() {
      yield* origin.files.keys();
    },
  });
  vi.stubGlobal("navigator", {
    locks: webLocksDouble(),
    onLine: true,
    storage: { getDirectory: async () => origin.directory },
  });
  configureHost({
    ...host(),
    storage: { local: createMemoryStorage(), session: createMemoryStorage() },
  });
  vaultStore.prepareGuestUnlock();
  await vaultStore.createGuest();
});
afterEach(async () => {
  cleanup();
  vaultStore.lock();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  kvForgetAll();
  unlockCeremonyStore.reset();
  compositionStore.resetForTest();
  restoreOriginPublicationFixture();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function settings() {
  const view = render(
    <MemoryRouter initialEntries={["/settings/security"]}>
      <App slots={slots} />
    </MemoryRouter>,
  );
  await screen.findByText("Authenticator app", { selector: ".sw__name" });
  return view;
}
async function openAuthenticator() {
  const row = screen
    .getByText("Authenticator app", { selector: ".sw__name" })
    .closest(".sw--method");
  if (!row || !(row instanceof HTMLElement))
    throw new Error("Missing authenticator row");
  await userEvent.click(within(row).getByRole("button", { name: "Add" }));
  return screen.getByRole("dialog", { name: "Authenticator app" });
}

it("keeps the original root dialog and three-step rail when actual guest PIN publication makes the same vault durable", async () => {
  const original = vaultStore.getSnapshot();
  expect(original).toMatchObject({
    status: "unlocked",
    tomb: GUEST_TOMB,
    guest: true,
    decoy: false,
  });
  await settings();
  const dialog = await openAuthenticator();
  expect(within(dialog).getByText("1 · Key")).toBeTruthy();
  expect(within(dialog).getByText("3 · Confirm")).toBeTruthy();
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Use a PIN instead" }),
  );
  fireEvent.change(within(dialog).getByLabelText("PIN", { exact: true }), {
    target: { value: PIN },
  });
  fireEvent.change(
    within(dialog).getByLabelText("Confirm PIN", { exact: true }),
    { target: { value: PIN } },
  );
  const submit = within(dialog).getByRole("button", { name: "Set PIN" });
  expect(submit).toHaveProperty("disabled", false);
  expect(submit.closest("form")).toBe(
    within(dialog).getByRole("form", { name: "Set PIN form" }),
  );
  // No implementation replacement: observe and await the exact store promise.
  const enrollment = vi.spyOn(vaultStore, "enrollPin");
  await userEvent.click(submit);
  expect(enrollment).toHaveBeenCalledExactlyOnceWith(PIN);
  await expect(enrollment.mock.results[0]?.value).resolves.toBeUndefined();
  // Observe genuine KDF/publication without leaving an unresolved async act
  // scope open if enrollment fails; the following cases still render normally.
  await waitFor(() => {
    expect(vaultStore.getSnapshot().header?.unlocks?.pin).toBeDefined();
    expect(vaultStore.getSnapshot().guest).toBe(false);
  });
  expect(
    await screen.findByRole("img", { name: "Scan to add vault MFA" }),
  ).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "Authenticator app" })).toBe(
    dialog,
  );
  expect(
    dialog.querySelector(".steps__seg.is-now .steps__label")?.textContent,
  ).toBe("2 · Scan");
  expect(
    dialog.querySelector(".steps__seg.is-done .steps__label")?.textContent,
  ).toBe("1 · Key");
  expect(within(dialog).getByText("3 · Confirm")).toBeTruthy();
  const promoted = vaultStore.getSnapshot();
  expect(promoted).toMatchObject({
    status: "unlocked",
    tomb: original.tomb,
    guest: false,
    decoy: false,
  });
  expect(promoted.header?.unlocks?.pin?.kdf.iterations).toBeGreaterThanOrEqual(
    PIN_PBKDF2_ITERATIONS,
  );
  expect(kvGet(tombFileKey(GUEST_TOMB, HEADER_PATH))).toContain('"pin"');
  await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  act(() => vaultStore.lock());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("Vault is locked")).toBeTruthy();
  await act(async () => {
    await vaultStore.unlockWithPin(PIN);
  });
  expect(vaultStore.getSnapshot()).toMatchObject({
    status: "unlocked",
    tomb: GUEST_TOMB,
    guest: false,
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps invalid PIN input uncommitted in the same guest ceremony", async () => {
  await settings();
  const dialog = await openAuthenticator();
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Use a PIN instead" }),
  );
  fireEvent.change(within(dialog).getByLabelText("PIN", { exact: true }), {
    target: { value: "11111111" },
  });
  fireEvent.change(
    within(dialog).getByLabelText("Confirm PIN", { exact: true }),
    { target: { value: "11111111" } },
  );
  expect(
    within(dialog).getByRole("button", { name: "Set PIN" }),
  ).toHaveProperty("disabled", true);
  expect(vaultStore.getSnapshot().guest).toBe(true);
  expect(vaultStore.getSnapshot().header?.unlocks?.pin).toBeUndefined();
  expect(kvGet(tombFileKey(GUEST_TOMB, HEADER_PATH))).toBeNull();
  expect(
    screen.queryByRole("img", { name: "Scan to add vault MFA" }),
  ).toBeNull();
});

it("discards a guest ceremony at lock, at the scratch-decoy actor boundary, and on a real tomb switch", async () => {
  await settings();
  const originalDialog = await openAuthenticator();
  await userEvent.click(
    within(originalDialog).getByRole("button", { name: "Use a PIN instead" }),
  );
  fireEvent.change(
    within(originalDialog).getByLabelText("PIN", { exact: true }),
    { target: { value: "retained draft" } },
  );
  await expect(
    vaultStore.createGuest({ decoy: true, scratch: true }),
  ).rejects.toThrow(/Lock/);
  await act(async () => {
    vaultStore.lock();
    await vaultStore.createGuest({ decoy: true, scratch: true });
  });
  expect(vaultStore.activeTomb()).toBe(DECOY_SCRATCH_TOMB);
  expect(vaultStore.getSnapshot()).toMatchObject({
    status: "unlocked",
    tomb: GUEST_TOMB,
    guest: true,
    decoy: true,
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.contains(originalDialog)).toBe(false);
  const nextDialog = await openAuthenticator();
  expect(nextDialog).not.toBe(originalDialog);
  act(() => vaultStore.loadActiveProjectScope());
  expect(vaultStore.activeTomb()).toBe(PERSONAL_TOMB);
  expect(vaultStore.getSnapshot().decoy).toBe(false);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.contains(nextDialog)).toBe(false);
});
