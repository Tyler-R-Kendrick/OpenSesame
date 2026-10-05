import { kvSet } from "@opensesame/app-core/lib/kv.js";
import * as localDevices from "@opensesame/app-core/lib/local-devices.js";
import { notifyLocalIamChange } from "@opensesame/app-core/lib/local-iam-events.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import { lockAllTombs, writeFile } from "@opensesame/app-core/lib/vfs.js";
/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { LocalDevicesPanel } from "./LocalDevicesPanel.js";

const { LOCAL_DEVICES_PATH, readLocalDevices, thisDeviceId, touchThisDevice } =
  localDevices;
const originalVault = { ...vaultHooksSeams };
const FULL = /this browser is not among them/;
let fixture: Awaited<ReturnType<typeof localRequestFixture>>;
beforeEach(async () => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  fixture = await localRequestFixture();
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ ...originalVault.useVault(), tomb: fixture.tomb }),
    useVaultStore: () => ({ activeTomb: () => fixture.tomb }),
  });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("No network permitted"),
  );
});
afterEach(() => {
  cleanup();
  lockAllTombs();
  Object.assign(vaultHooksSeams, originalVault);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function openDevices() {
  return render(
    <MemoryRouter>
      <LocalDevicesPanel tomb={fixture.tomb} />
    </MemoryRouter>,
  );
}

/** Open the vault as another browser from here on; restored after the test. */
function becomeAnotherBrowser() {
  const previous = thisDeviceId();
  kvSet("opensesame.this-device-id", crypto.randomUUID());
  onTestFinished(() => kvSet("opensesame.this-device-id", previous));
}

/** Browsers that opened the vault before, as their records stand. */
async function writeBrowsers(names: readonly string[]) {
  const now = new Date().toISOString();
  const devices = names.map((name, index) => ({
    id: `browser-${index}`,
    name,
    platform: "Linux",
    createdAt: now,
    lastSeenAt: now,
  }));
  await writeFile(
    fixture.tomb,
    LOCAL_DEVICES_PATH,
    new TextEncoder().encode(
      JSON.stringify({ version: 1, revision: 1, devices }),
    ),
  );
}

async function fillTheList() {
  await writeBrowsers(
    Array.from({ length: 63 }, (_, index) => `Device ${index}`),
  );
  await touchThisDevice(fixture.tomb);
}

it("says so when a full list leaves this browser unlisted, and lists it once a slot frees", async () => {
  await fillTheList();
  becomeAnotherBrowser();
  openDevices();
  expect(await screen.findByRole("img", { name: FULL })).toBeTruthy();
  expect(await readLocalDevices(fixture.tomb)).toHaveLength(64);

  const row = (
    await screen.findByRole("heading", { name: "Device 5" })
  ).closest("li");
  if (!row) throw new Error("expected the Device 5 row");
  await userEvent.click(
    within(row).getByRole("button", { name: "Remove Device 5" }),
  );
  await userEvent.click(
    within(row).getByRole("button", { name: "Confirm removing Device 5" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Device 5" })).toBeNull(),
  );
  // Reload touches again: the freed slot lists this browser.
  await userEvent.click(
    screen.getByRole("button", { name: "Reload browsers" }),
  );
  expect(await screen.findByRole("img", { name: "This device" })).toBeTruthy();
  expect(screen.queryByRole("img", { name: FULL })).toBeNull();
});

it("does not call a list full when this browser is merely missing from it", async () => {
  await writeBrowsers(["Studio Mac"]);
  // A read that lands before this browser's touch shows a list without it.
  vi.spyOn(localDevices, "touchThisDevice").mockImplementation((tomb) =>
    localDevices.readLocalDevices(tomb),
  );
  becomeAnotherBrowser();
  openDevices();
  expect(
    await screen.findByRole("heading", { name: "Studio Mac" }),
  ).toBeTruthy();
  expect(screen.queryByRole("img", { name: FULL })).toBeNull();
});

it("clears a read error once a later read lands", async () => {
  vi.spyOn(localDevices, "touchThisDevice").mockRejectedValueOnce(
    new Error("storage briefly unavailable"),
  );
  openDevices();
  const readError = /Could not read devices/;
  expect(await screen.findByRole("img", { name: readError })).toBeTruthy();
  await act(async () => {
    notifyLocalIamChange();
  });
  await waitFor(() =>
    expect(screen.queryByRole("img", { name: readError })).toBeNull(),
  );
  // The read's own result is on screen, not a loading state.
  expect(screen.queryByRole("img", { name: "Loading browsers…" })).toBeNull();
});
