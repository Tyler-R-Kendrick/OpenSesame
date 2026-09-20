/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as deviceIdentity from "../lib/device-identity.js";
import { ensureDefaultAccess } from "../lib/local-access-bootstrap.js";
import { mintGuestSessionPerson } from "../lib/local-guest.js";
import { listLocalShares } from "../lib/local-share-grants.js";
import { vaultStore } from "../lib/vault/store.js";
import { GUEST_TOMB, lockAllTombs } from "../lib/vfs.js";
import { IdentitySection } from "./IdentitySection.js";

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  let queue = Promise.resolve();
  vi.stubGlobal("navigator", {
    locks: {
      request: (_name: string, action: () => Promise<void>) => {
        const next = queue.then(action);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
  });
  vi.spyOn(deviceIdentity, "isRemoteIdentityConfigured").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("lists this Guest N on People even when a hosted Identity API is configured", async () => {
  const guest = mintGuestSessionPerson();
  await vaultStore.createGuest();
  expect(vaultStore.getSnapshot().tomb).toBe(GUEST_TOMB);
  expect(vaultStore.getSnapshot().guest).toBe(true);
  await ensureDefaultAccess(GUEST_TOMB);

  render(
    <MemoryRouter initialEntries={["/identity?view=people"]}>
      <IdentitySection />
    </MemoryRouter>,
  );

  await waitFor(() => {
    expect(screen.getByText(guest.name)).toBeTruthy();
  });
  expect(document.getElementById(guest.id)).toBeTruthy();

  const shares = await listLocalShares(GUEST_TOMB);
  expect(
    shares.some(
      (share) =>
        share.principalId === guest.id && share.resourceId === GUEST_TOMB,
    ),
  ).toBe(true);
});
