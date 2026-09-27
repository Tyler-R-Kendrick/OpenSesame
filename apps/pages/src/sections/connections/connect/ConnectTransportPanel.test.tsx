/** @vitest-environment jsdom */
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { kvGet } from "@opensesame/app-core/lib/kv.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import {
  CONNECT_AUTH_PATH,
  armVercelConnectAuth,
  clearPendingVercelConnectAuth,
  readVercelConnectAuth,
} from "@opensesame/app-core/lib/vercel-connect-session.js";
import {
  setVercelConnectAuth,
  vercelConnectAuth,
} from "@opensesame/app-core/lib/vercel-connect.js";
import { lockAllTombs, tombFileKey } from "@opensesame/app-core/lib/vfs.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { identityHookSeams } from "../../../bindings/identity.js";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { ConnectPanels } from "./ConnectPanels.js";

const originalVaultHooksSeams = { ...vaultHooksSeams };
const originalIdentityHookSeams = { ...identityHookSeams };

function resend(): Provider {
  const found = mergeVercelCatalog(getBundledProviders()).find(
    (row) => row.id === "resend",
  );
  if (!found) throw new Error("resend not in catalog");
  return found;
}

function draw(onFlash = vi.fn()) {
  render(
    <ConnectPanels
      provider={resend()}
      connection={null}
      online
      onFlash={onFlash}
      onChanged={vi.fn()}
    />,
  );
  return onFlash;
}

async function openVault(): Promise<string> {
  const fixture = await localRequestFixture();
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ ...vaultStore.getSnapshot(), tomb: fixture.tomb }),
  });
  return fixture.tomb;
}

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  Object.assign(identityHookSeams, {
    useIdentitySession: () => ({ principalId: "prn_person" }),
  });
});

afterEach(() => {
  cleanup();
  setVercelConnectAuth(null);
  clearPendingVercelConnectAuth();
  Object.assign(vaultHooksSeams, originalVaultHooksSeams);
  Object.assign(identityHookSeams, originalIdentityHookSeams);
  lockAllTombs();
  vi.unstubAllGlobals();
});

it("forgets the sealed Connect credential: out of memory and out of the vault", async () => {
  const tomb = await openVault();
  await armVercelConnectAuth({ token: "vercel_token", teamId: "team_1" }, tomb);
  expect(await readVercelConnectAuth(tomb)).toEqual({
    token: "vercel_token",
    teamId: "team_1",
  });

  const onFlash = draw();
  // Armed, the panel is only the key that forgets it — no form to fill.
  expect(screen.queryByLabelText("Vercel access token")).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Forget Vercel Connect" }),
  );

  // The flash comes only once the forget has settled — memory first, then
  // the sealed record — so everything below is read after it.
  await waitFor(() =>
    expect(onFlash).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "ok" }),
    ),
  );
  expect(vercelConnectAuth()).toBeNull();
  expect(await readVercelConnectAuth(tomb)).toBeNull();
  expect(kvGet(tombFileKey(tomb, CONNECT_AUTH_PATH))).toBeFalsy();
  // Nothing held: the form asks again, and there is nothing left to forget.
  await screen.findByLabelText("Vercel access token");
  expect(
    screen.queryByRole("button", { name: "Forget Vercel Connect" }),
  ).toBeNull();
});

it("offers no forget key when no Connect credential is held", async () => {
  await openVault();
  draw();
  expect(screen.getByRole("region", { name: "Vercel Connect" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Forget Vercel Connect" }),
  ).toBeNull();
});
