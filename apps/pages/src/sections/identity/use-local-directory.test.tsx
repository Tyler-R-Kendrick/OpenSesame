/** @vitest-environment jsdom */
import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import { withLocalIdentitySession } from "@opensesame/app-core/lib/local-sessions.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { useIdentityRailSnapshot } from "./use-local-directory.js";

const originalVault = { ...vaultHooksSeams };
afterEach(() => {
  cleanup();
  lockAllTombs();
  Object.assign(vaultHooksSeams, originalVault);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function Snapshot({ label }: { label: string }) {
  const snapshot = useIdentityRailSnapshot();
  return <output data-testid={label}>{snapshot.directory?.length ?? 0}</output>;
}

it("mounts sidebar and phone navigation without changing the sealed directory or invalidating a real session", async () => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  const fixture = await localRequestFixture();
  const before = await readLocalDirectory(fixture.tomb);
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ ...originalVault.useVault(), tomb: fixture.tomb }),
    useVaultStore: () => ({ activeTomb: () => fixture.tomb }),
  });
  render(
    <>
      <Snapshot label="sidebar" />
      <Snapshot label="phone" />
    </>,
  );
  await waitFor(() => {
    expect(screen.getByTestId("sidebar").textContent).toBe("3");
    expect(screen.getByTestId("phone").textContent).toBe("3");
  });
  expect(await readLocalDirectory(fixture.tomb)).toEqual(before);
  expect(
    await withLocalIdentitySession(
      fixture.tomb,
      fixture.session,
      async (identity) => identity.principalId,
    ),
  ).toBe(fixture.personId);
});
