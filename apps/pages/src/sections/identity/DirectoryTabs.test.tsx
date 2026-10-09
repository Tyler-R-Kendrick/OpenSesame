/** @vitest-environment jsdom */
import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { DevicesTab } from "./DirectoryTabs.js";
import { contributeDirectoryPanels } from "./directory-panel-slot.js";

const originalVault = { ...vaultHooksSeams };
const originalRemote = deviceIdentitySeams.remoteIdentityApi;
let remote: string;
let revoke: () => void;
const approval = vi.fn(() => <h1>Approve a device</h1>);
beforeEach(async () => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  const fixture = await localRequestFixture();
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ ...originalVault.useVault(), tomb: fixture.tomb }),
    useVaultStore: () => ({ activeTomb: () => fixture.tomb }),
  });
  remote = "";
  deviceIdentitySeams.remoteIdentityApi = () => remote;
  approval.mockClear();
  revoke = contributeDirectoryPanels({
    People: () => null,
    Agents: () => null,
    Devices: approval,
    OrgSignIn: () => null,
  });
});
afterEach(() => {
  cleanup();
  revoke();
  lockAllTombs();
  Object.assign(vaultHooksSeams, originalVault);
  deviceIdentitySeams.remoteIdentityApi = originalRemote;
  vi.unstubAllGlobals();
});
function openDevices() {
  return render(
    <MemoryRouter initialEntries={["/identity?view=devices"]}>
      <DevicesTab online session={null} />
    </MemoryRouter>,
  );
}

it("omits an unavailable remote approval record while retaining the real browser list", async () => {
  openDevices();
  expect(
    await screen.findByRole("button", { name: "Reload browsers" }),
  ).toBeTruthy();
  expect(
    await screen.findByRole("treeitem", { name: /\.device$/ }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("treeitem", { name: "Approve a device" }),
  ).toBeNull();
  expect(approval).not.toHaveBeenCalled();
});

it("opens the contributed approval detail when the remote identity plane is configured", async () => {
  remote = "https://identity.example.test";
  openDevices();
  await userEvent.click(
    await screen.findByRole("treeitem", { name: "Approve a device" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Approve a device" }),
  ).toBeTruthy();
  expect(approval).toHaveBeenCalled();
});
