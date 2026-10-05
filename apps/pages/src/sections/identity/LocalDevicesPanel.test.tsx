import {
  readLocalPasskeys,
  revokeLocalPasskey,
} from "@opensesame/app-core/lib/local-credentials.js";
import {
  LOCAL_DEVICES_PATH,
  readLocalDevices,
  thisDeviceId,
  touchThisDevice,
  updateLocalDevice,
} from "@opensesame/app-core/lib/local-devices.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import { currentLocalIdentitySession } from "@opensesame/app-core/lib/local-sessions.js";
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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { LocalDevicesPanel } from "./LocalDevicesPanel.js";
import { LocalDirectoryPanel } from "./LocalDirectoryPanel.js";

const originalVault = { ...vaultHooksSeams };
let fixture: Awaited<ReturnType<typeof localRequestFixture>>;
beforeEach(async () => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  fixture = await localRequestFixture();
  // The panels read the session's tomb from the reactive vault state, so the
  // fixture's tomb is the one that state names.
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
function openPeople() {
  return render(
    <MemoryRouter>
      <LocalDirectoryPanel kind="person" />
      <button type="button">Another control</button>
    </MemoryRouter>,
  );
}

function openDevices(tomb = fixture.tomb) {
  return render(
    <MemoryRouter>
      <LocalDevicesPanel tomb={tomb} />
    </MemoryRouter>,
  );
}

it("revokes a real enrolled passkey and its authentication from Devices without a backend", async () => {
  openPeople();
  const personHeading = await screen.findByRole("heading", {
    level: 3,
    name: "Test person",
  });
  const personRow = personHeading.closest("li");
  if (!personRow) throw new Error("expected Test person row");
  await userEvent.click(
    within(personRow).getByText("Passkeys", { exact: true }),
  );
  const revoke = await screen.findByRole("button", { name: "Revoke passkey" });
  await userEvent.click(revoke);
  await userEvent.click(screen.getByRole("button", { name: "Keep passkey" }));
  expect(document.activeElement).toBe(revoke);
  expect(await readLocalPasskeys(fixture.tomb)).toHaveLength(1);
  await userEvent.click(revoke);
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm revocation" }),
  );
  // One mark carries the disclosure's status, and the outcome of the action
  // the person just took outranks the empty state (LocalPasskeys.tsx
  // `passkeySurfaceStatus`): idle, because no passkey is left.
  const outcome = await screen.findByRole("img", { name: "Passkey revoked." });
  expect(outcome.className).toContain("status-mark--idle");
  expect(screen.queryByRole("button", { name: "Revoke passkey" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Confirm revocation" }),
  ).toBeNull();
  expect(await readLocalPasskeys(fixture.tomb)).toHaveLength(0);
  expect(
    await currentLocalIdentitySession(fixture.tomb, fixture.personId),
  ).toBeNull();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("refreshes an open passkey disclosure after another surface revokes its credential", async () => {
  openPeople();
  const personHeading = await screen.findByRole("heading", {
    level: 3,
    name: "Test person",
  });
  const personRow = personHeading.closest("li");
  if (!personRow) throw new Error("expected Test person row");
  await userEvent.click(
    await within(personRow).findByText("Passkeys", { exact: true }),
  );
  await screen.findByRole("button", { name: "Revoke passkey" });
  screen.getByRole("button", { name: "Revoke passkey" }).focus();
  const key = (await readLocalPasskeys(fixture.tomb))[0];
  if (!key) throw new Error("Missing credential fixture");
  await act(() =>
    revokeLocalPasskey(fixture.tomb, fixture.personId, key.credentialId),
  );
  await screen.findByRole("img", { name: "No passkeys enrolled." });
  expect(screen.queryByRole("button", { name: "Revoke passkey" })).toBeNull();
  expect(document.activeElement).toBe(
    within(personRow).getByText("Passkeys", { exact: true }),
  );
});

it("distinguishes unreadable credentials from an empty directory and refuses stale controls", async () => {
  openPeople();
  const personHeading = await screen.findByRole("heading", {
    level: 3,
    name: "Test person",
  });
  const personRow = personHeading.closest("li");
  if (!personRow) throw new Error("expected Test person row");
  await userEvent.click(
    await within(personRow).findByText("Passkeys", { exact: true }),
  );
  await screen.findByRole("button", { name: "Enroll passkey" });
  lockAllTombs();
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() =>
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0),
  );
  expect(screen.getByRole("button", { name: "Enroll passkey" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(
    screen.queryByRole("img", { name: "No passkeys enrolled." }),
  ).toBeNull();
  expect(screen.queryByRole("link", { name: "Create a person" })).toBeNull();
});

it("lists this browser as a device, not people or passkeys", async () => {
  openDevices();
  const heading = await screen.findByRole("heading", { level: 3 });
  const row = heading.closest("li");
  if (!row) throw new Error("expected this device's row");
  expect(within(row).getByRole("img", { name: "This device" })).toBeTruthy();
  expect(screen.queryByText("Passkeys", { exact: true })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Test person" })).toBeNull();
  // The device you are on can be renamed, never removed.
  expect(within(row).queryByRole("button", { name: /^Remove / })).toBeNull();
  await userEvent.click(within(row).getByRole("button", { name: /^Edit / }));
  expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  expect(screen.queryByLabelText("Platform")).toBeNull();
  await userEvent.clear(screen.getByLabelText("Name"));
  await userEvent.type(screen.getByLabelText("Name"), "Desk laptop");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(
    await screen.findByRole("heading", { name: "Desk laptop" }),
  ).toBeTruthy();
});

/** A record an earlier build let a person type in by hand: never seen. */
async function writeHandTyped(name: string): Promise<void> {
  const devices = [
    ...(await touchThisDevice(fixture.tomb)),
    {
      id: "typed-by-hand",
      name,
      platform: "Windows",
      createdAt: new Date().toISOString(),
      lastSeenAt: "",
    },
  ];
  await writeFile(
    fixture.tomb,
    LOCAL_DEVICES_PATH,
    new TextEncoder().encode(
      JSON.stringify({ version: 1, revision: 9, devices }),
    ),
  );
}

it("offers no way to invent a device: the list is the browsers that opened the vault", async () => {
  openDevices();
  await screen.findByRole("img", { name: "This device" });
  expect(
    screen.getByRole("region", { name: "This vault's browsers" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /New device|Register/ }),
  ).toBeNull();
  expect(screen.queryByLabelText("Platform")).toBeNull();
});

it("shows a hand-typed record for what it is, and removes it behind an armed key", async () => {
  await writeHandTyped("Work laptop");
  openDevices();
  const heading = await screen.findByRole("heading", { name: "Work laptop" });
  const row = heading.closest("li");
  if (!row) throw new Error("expected the hand-typed row");
  expect(
    within(row).getByRole("img", {
      name: "Typed in by hand; no browser opened the vault as it",
    }),
  ).toBeTruthy();
  expect(within(row).queryByRole("button", { name: /^Claim / })).toBeNull();
  const remove = within(row).getByRole("button", {
    name: "Remove Work laptop",
  });
  await userEvent.click(remove);
  await userEvent.click(
    within(row).getByRole("button", { name: "Keep Work laptop" }),
  );
  expect(document.activeElement).toBe(remove);
  expect(await readLocalDevices(fixture.tomb)).toHaveLength(2);
  await userEvent.click(remove);
  await userEvent.click(
    within(row).getByRole("button", { name: "Confirm removing Work laptop" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Work laptop" })).toBeNull(),
  );
  const stored = await readLocalDevices(fixture.tomb);
  expect(stored.map((device) => device.id)).toEqual([thisDeviceId()]);
  // The row left with the key that had focus; focus lands on the reload key.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Reload browsers" }),
    ),
  );
});

it("renames a seen device whose stored platform is empty", async () => {
  const now = new Date().toISOString();
  await writeFile(
    fixture.tomb,
    LOCAL_DEVICES_PATH,
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        revision: 1,
        devices: [
          {
            id: "old-box",
            name: "Old box",
            platform: "",
            createdAt: now,
            lastSeenAt: now,
          },
        ],
      }),
    ),
  );
  openDevices();
  const row = (await screen.findByRole("heading", { name: "Old box" })).closest(
    "li",
  );
  if (!row) throw new Error("expected the stored row");
  await userEvent.click(
    within(row).getByRole("button", { name: "Edit Old box" }),
  );
  expect(screen.queryByLabelText("Platform")).toBeNull();
  await userEvent.clear(screen.getByLabelText("Name"));
  await userEvent.type(screen.getByLabelText("Name"), "Attic box");
  const save = screen.getByRole("button", { name: "Save changes" });
  expect(save).toHaveProperty("disabled", false);
  await userEvent.click(save);
  expect(
    await screen.findByRole("heading", { name: "Attic box" }),
  ).toBeTruthy();
});

it("follows a change made on another surface and reloads on demand", async () => {
  openDevices();
  await screen.findByRole("img", { name: "This device" });
  await act(() =>
    updateLocalDevice(fixture.tomb, thisDeviceId(), { name: "Studio Mac" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Studio Mac" }),
  ).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "Reload browsers" }),
  );
  expect(screen.getByRole("heading", { name: "Studio Mac" })).toBeTruthy();
});
