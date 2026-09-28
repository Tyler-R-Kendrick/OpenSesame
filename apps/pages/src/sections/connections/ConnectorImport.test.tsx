import {
  clearPendingConnectorDirectory,
  connectorDirectorySeams,
  readConnectorDirectory,
} from "@opensesame/app-core/lib/connector-directory.js";
import { kvDelete } from "@opensesame/app-core/lib/kv.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { ConnectorImport } from "./ConnectorImport.js";

const originalList = connectorDirectorySeams.listDirectory;
const originalVault = { ...vaultHooksSeams };

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  connectorDirectorySeams.listDirectory = vi.fn(async () => ({
    integrations: [],
    connections: [
      {
        id: "1",
        connectionId: "octocat",
        integrationId: "github",
        provider: "github",
        displayName: "GitHub",
        endUser: null,
        createdAt: null,
        errors: 0,
      },
    ],
  }));
});

afterEach(() => {
  cleanup();
  clearPendingConnectorDirectory();
  connectorDirectorySeams.listDirectory = originalList;
  Object.assign(vaultHooksSeams, originalVault);
  kvDelete("connector-directory.v1");
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount() {
  const fixture = await localRequestFixture();
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ tomb: fixture.tomb, status: "unlocked", items: [] }),
  });
  const onImported = vi.fn();
  const onClose = vi.fn();
  const onFlash = vi.fn();
  render(
    <ConnectorImport
      tomb={fixture.tomb}
      onFlash={onFlash}
      onImported={onImported}
      onClose={onClose}
    />,
  );
  return { fixture, onImported, onClose, onFlash };
}

it("offers the sources and asks nothing until one is chosen", async () => {
  await mount();
  const sources = screen.getByRole("list", { name: "Import from" });
  expect(sources.querySelectorAll("button")).toHaveLength(2);
  expect(screen.getByRole("button", { name: /Nango/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Vercel Connect/ })).toBeTruthy();
  expect(screen.queryByLabelText("Directory endpoint")).toBeNull();
  expect(screen.queryByLabelText("Vercel access token")).toBeNull();
});

it("imports a Nango directory's connectors into this vault", async () => {
  const { fixture, onImported } = await mount();
  await userEvent.click(screen.getByRole("button", { name: /Nango/ }));
  await userEvent.type(
    screen.getByLabelText("Directory endpoint"),
    "https://api.nango.dev",
  );
  await userEvent.type(screen.getByLabelText("Environment key"), "sk-env");
  await userEvent.click(
    screen.getByRole("button", { name: "Sync connectors" }),
  );
  await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
  expect(connectorDirectorySeams.listDirectory).toHaveBeenCalledWith(
    "https://api.nango.dev",
    "sk-env",
  );
  const record = await readConnectorDirectory(fixture.tomb);
  expect(record?.connections.map((row) => row.connectionId)).toEqual([
    "octocat",
  ]);
});

it("asks for the Vercel Connect credential when Vercel Connect is chosen", async () => {
  await mount();
  await userEvent.click(screen.getByRole("button", { name: /Vercel Connect/ }));
  expect(screen.getByLabelText("Vercel access token")).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Seal in vault" })
      .disabled,
  ).toBe(true);
  expect(screen.queryByLabelText("Directory endpoint")).toBeNull();
});

it("Escape closes the import", async () => {
  const { onClose } = await mount();
  await userEvent.click(screen.getByRole("button", { name: /Nango/ }));
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
});
