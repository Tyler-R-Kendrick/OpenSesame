/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  readLocalPasskeys,
  revokeLocalPasskey,
} from "../../lib/local-credentials.js";
import { localRequestFixture } from "../../lib/local-request.fixture.js";
import { currentLocalIdentitySession } from "../../lib/local-sessions.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { lockAllTombs } from "../../lib/vfs.js";
import { LocalDevicesPanel } from "./LocalDevicesPanel.js";
import { LocalDirectoryPanel } from "./LocalDirectoryPanel.js";

const originalVault = { ...vaultHooksSeams };
let fixture: Awaited<ReturnType<typeof localRequestFixture>>;
beforeEach(async () => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  fixture = await localRequestFixture();
  Object.assign(vaultHooksSeams, {
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
  await screen.findByRole("heading", { name: "Test person" });
  await userEvent.click(screen.getByText("Passkeys", { exact: true }));
  const revoke = await screen.findByRole("button", { name: "Revoke passkey" });
  await userEvent.click(revoke);
  await userEvent.click(screen.getByRole("button", { name: "Keep passkey" }));
  expect(document.activeElement).toBe(revoke);
  expect(await readLocalPasskeys(fixture.tomb)).toHaveLength(1);
  await userEvent.click(revoke);
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm revocation" }),
  );
  await screen.findByText("No passkeys enrolled.");
  expect(await readLocalPasskeys(fixture.tomb)).toHaveLength(0);
  expect(
    await currentLocalIdentitySession(fixture.tomb, fixture.personId),
  ).toBeNull();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("refreshes an open passkey disclosure after another surface revokes its credential", async () => {
  openPeople();
  await userEvent.click(await screen.findByText("Passkeys", { exact: true }));
  await screen.findByRole("button", { name: "Revoke passkey" });
  screen.getByRole("button", { name: "Revoke passkey" }).focus();
  const key = (await readLocalPasskeys(fixture.tomb))[0];
  if (!key) throw new Error("Missing credential fixture");
  await act(() =>
    revokeLocalPasskey(fixture.tomb, fixture.personId, key.credentialId),
  );
  await screen.findByText("No passkeys enrolled.");
  expect(screen.queryByRole("button", { name: "Revoke passkey" })).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByText("Passkeys", { exact: true }),
  );
});

it("distinguishes unreadable credentials from an empty directory and refuses stale controls", async () => {
  openPeople();
  await userEvent.click(await screen.findByText("Passkeys", { exact: true }));
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
  expect(screen.queryByText("No passkeys enrolled.")).toBeNull();
  expect(screen.queryByRole("link", { name: "Create a person" })).toBeNull();
});

it("lists this browser as a device, not people or passkeys", async () => {
  openDevices();
  expect(await screen.findByText("This device")).toBeTruthy();
  expect(screen.queryByText("Passkeys", { exact: true })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Test person" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /Rename / }));
  await userEvent.clear(screen.getByLabelText("Name"));
  await userEvent.type(screen.getByLabelText("Name"), "Desk laptop");
  await userEvent.click(screen.getByRole("button", { name: "Save name" }));
  expect(
    await screen.findByRole("heading", { name: "Desk laptop" }),
  ).toBeTruthy();
});
