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
import {
  readLocalPasskeys,
  revokeLocalPasskey,
} from "../../lib/local-credentials.js";
import { localRequestFixture } from "../../lib/local-request.fixture.js";
import { currentLocalIdentitySession } from "../../lib/local-sessions.js";
import { mintVaultKey } from "../../lib/vault/crypto.js";
import { lockAllTombs, unlockTomb } from "../../lib/vfs.js";
import { LocalDevicesPanel } from "./LocalDevicesPanel.js";

let fixture: Awaited<ReturnType<typeof localRequestFixture>>;
beforeEach(async () => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  fixture = await localRequestFixture();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("No network permitted"),
  );
});
afterEach(() => {
  cleanup();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function open(tomb = fixture.tomb) {
  return render(
    <MemoryRouter>
      <LocalDevicesPanel tomb={tomb} />
      <button type="button">Another control</button>
    </MemoryRouter>,
  );
}

it("revokes a real enrolled passkey and its authentication from Devices without a backend", async () => {
  open();
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
  open();
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
  open();
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

it("offers an actionable empty state in a fresh encrypted vault", async () => {
  const tomb = `empty-devices-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  open(tomb);
  const link = await screen.findByRole("link", { name: "Create a person" });
  expect(link.getAttribute("href")).toBe("/identity?view=people");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it.each(["removed row", "another control"] as const)(
  "preserves useful focus after external principal deletion from %s",
  async (location) => {
    const next = await fixture.change({
      action: "create",
      kind: "person",
      name: "Removable person",
    });
    const person = next.entries.find(
      (entry) => entry.name === "Removable person",
    );
    if (!person) throw new Error("Missing removable person");
    open();
    const heading = await screen.findByRole("heading", {
      name: "Removable person",
    });
    const row = heading.closest("li");
    if (!row) throw new Error("Missing identity row");
    const outside = screen.getByRole("button", { name: "Another control" });
    const target =
      location === "removed row"
        ? within(row).getByText("Passkeys", { exact: true })
        : outside;
    target.focus();
    await act(() => fixture.change({ action: "delete", id: person.id }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Removable person" }),
      ).toBeNull(),
    );
    expect(document.activeElement).toBe(
      location === "removed row"
        ? screen.getByRole("button", { name: "Reload directory" })
        : outside,
    );
  },
);
