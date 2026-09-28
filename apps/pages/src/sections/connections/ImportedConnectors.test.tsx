import {
  clearPendingConnectorDirectory,
  connectorDirectorySeams,
  syncConnectorDirectory,
} from "@opensesame/app-core/lib/connector-directory.js";
import { kvDelete } from "@opensesame/app-core/lib/kv.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import type { DirectoryConnection } from "@opensesame/app-core/lib/nango-directory.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
/** @vitest-environment jsdom */
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectedPanel } from "./ConnectedPanel.js";
import { ImportedGroup, useImportedDirectory } from "./ImportedConnectors.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

const github: DirectoryConnection = {
  id: "1",
  connectionId: "octocat",
  integrationId: "github",
  provider: "github",
  displayName: "GitHub",
  endUser: "octo@example.com",
  createdAt: null,
  errors: 0,
};
const slack: DirectoryConnection = {
  ...github,
  id: "2",
  connectionId: "acme",
  integrationId: "slack",
  provider: "slack",
  displayName: "Slack",
  endUser: null,
  errors: 2,
};

const originalList = connectorDirectorySeams.listDirectory;

// The panel mounts `connections.connected`, a guide target
// `connectors.external` contributes; these cases describe a deployment
// that approved it.
declareConnectionsTutorial();

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  connectorDirectorySeams.listDirectory = vi.fn(async () => ({
    integrations: [],
    connections: [github, slack],
  }));
});

afterEach(() => {
  cleanup();
  clearPendingConnectorDirectory();
  connectorDirectorySeams.listDirectory = originalList;
  kvDelete("connector-directory.v1");
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Connected as the page draws it: nothing live, the imported group after. */
function Page({
  tomb,
  onFlash,
}: { tomb: string; onFlash: (flash: Flash) => void }) {
  const imported = useImportedDirectory(tomb);
  return (
    <MemoryRouter>
      <ConnectedPanel
        connections={[]}
        providers={[]}
        loading={false}
        setupRequired={false}
        imported={
          imported.record ? (
            <ImportedGroup
              record={imported.record}
              busy={imported.busy}
              onResync={() => void imported.resync(onFlash)}
            />
          ) : null
        }
      />
    </MemoryRouter>
  );
}

it("lists the imported connectors under Connected, with their health, and not 'Nothing connected'", async () => {
  const fixture = await localRequestFixture();
  await syncConnectorDirectory({
    endpoint: "https://api.nango.dev",
    key: "sk-env",
    tomb: fixture.tomb,
  });
  render(<Page tomb={fixture.tomb} onFlash={vi.fn()} />);
  const list = within(
    await screen.findByRole("list", { name: "Imported from api.nango.dev" }),
  );
  expect(
    list.getByRole("heading", { name: "GitHub · octo@example.com" }),
  ).toBeTruthy();
  expect(list.getByRole("img", { name: "Authorized" })).toBeTruthy();
  expect(list.getByRole("img", { name: "2 errors" })).toBeTruthy();
  expect(
    screen.getByText(/^api\.nango\.dev · 2 connectors · synced /),
  ).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "Nothing connected" }),
  ).toBeNull();
});

it("imports again with the sealed key, and says how many came back", async () => {
  const fixture = await localRequestFixture();
  await syncConnectorDirectory({
    endpoint: "https://api.nango.dev",
    key: "sk-env",
    tomb: fixture.tomb,
  });
  connectorDirectorySeams.listDirectory = vi.fn(async () => ({
    integrations: [],
    connections: [github],
  }));
  const onFlash = vi.fn();
  render(<Page tomb={fixture.tomb} onFlash={onFlash} />);
  await userEvent.click(
    await screen.findByRole("button", {
      name: "Import again from api.nango.dev",
    }),
  );
  await screen.findByText(/^api\.nango\.dev · 1 connector · synced /);
  expect(connectorDirectorySeams.listDirectory).toHaveBeenCalledWith(
    "https://api.nango.dev",
    "sk-env",
  );
  expect(onFlash).toHaveBeenCalledWith({
    tone: "ok",
    text: "1 connector imported from api.nango.dev.",
  });
});

it("draws nothing with nothing imported, and Connected says so", async () => {
  const fixture = await localRequestFixture();
  render(<Page tomb={fixture.tomb} onFlash={vi.fn()} />);
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Nothing connected" }),
    ).toBeTruthy(),
  );
  expect(screen.queryByRole("list", { name: /Imported from/ })).toBeNull();
});
