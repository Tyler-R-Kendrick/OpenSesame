/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ConnectorDirectoryForm,
  connectorDirectoryFormDependencies as deps,
} from "./ConnectorDirectoryForm.js";

const original = { ...deps };
let stored = "";

beforeEach(() => {
  stored = "https://api.nango.dev";
  deps.readDirectoryEndpoint = () => stored;
  deps.writeDirectoryEndpoint = vi.fn(async (next: string) => {
    stored = next;
  });
  deps.pendingConnectorDirectory = () => null;
  deps.pageIsLoopback = () => false;
});

afterEach(() => {
  cleanup();
  Object.assign(deps, original);
});

it("never lets a slip while editing erase the endpoint on record", async () => {
  render(<ConnectorDirectoryForm tomb={null} />);
  const field = screen.getByLabelText("Directory endpoint");
  await userEvent.clear(field);
  await userEvent.type(field, "api.nango.dev");
  await userEvent.tab();
  expect(deps.writeDirectoryEndpoint).not.toHaveBeenCalled();
  expect(stored).toBe("https://api.nango.dev");
  // Not an address this page may call, so nothing to sync either.
  expect(
    (
      screen.getByRole("button", {
        name: "Sync connectors",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("writes a valid address, and an emptied field, on commit", async () => {
  render(<ConnectorDirectoryForm tomb={null} />);
  const field = screen.getByLabelText("Directory endpoint");
  await userEvent.clear(field);
  await userEvent.type(field, "https://proxy.example/nango/");
  await userEvent.tab();
  expect(stored).toBe("https://proxy.example/nango");
  await userEvent.clear(field);
  await userEvent.tab();
  expect(stored).toBe("");
});
