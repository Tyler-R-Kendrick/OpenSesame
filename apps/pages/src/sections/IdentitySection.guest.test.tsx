import * as deviceIdentity from "@opensesame/app-core/lib/device-identity.js";
import { ensureDefaultAccess } from "@opensesame/app-core/lib/local-access-bootstrap.js";
import { mintGuestSessionPerson } from "@opensesame/app-core/lib/local-guest.js";
import { listLocalShares } from "@opensesame/app-core/lib/local-share-grants.js";
/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";

import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { GUEST_TOMB, lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
import {
  IDENTITY_ROUTES,
  IDENTITY_TARGETS,
} from "@opensesame/app-core/tutorial/registry/identity-catalog.js";
import { IDENTITY_GOALS } from "@opensesame/app-core/tutorial/registry/identity-goals.js";
import { declareTutorialForTest } from "../modules/tutorial-test-realm.js";
import { IdentitySection } from "./IdentitySection.js";
import { contributeIdentityForTests } from "./identity/identity-test-support.js";

import { IDENTITY_VIEWS } from "@opensesame/app-core/lib/section-view-names.js";
// The Identity tabs belong to three capabilities (local IAM, federation,
// directory provisioning), and each contributes its own view. These cases
// describe a deployment that approved them, so they register the same
// contributions the modules make at activation.
let revokeIdentityViews: (() => void) | null = null;
let undeclareTutorial: (() => void) | null = null;
beforeEach(async () => {
  revokeIdentityViews = contributeIdentityForTests(IDENTITY_VIEWS);
  undeclareTutorial = await declareTutorialForTest("identity.federation", {
    targets: IDENTITY_TARGETS,
    goals: IDENTITY_GOALS,
    routes: IDENTITY_ROUTES,
  });
});
afterEach(() => {
  undeclareTutorial?.();
  undeclareTutorial = null;
  revokeIdentityViews?.();
  revokeIdentityViews = null;
});

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
