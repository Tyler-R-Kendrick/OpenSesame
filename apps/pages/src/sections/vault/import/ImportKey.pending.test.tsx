/** @vitest-environment jsdom */
import {
  discardPendingImport,
  holdPendingImport,
  peekPendingImport,
} from "@opensesame/app-core/lib/vault/pending-import.js";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const applyImport = vi.hoisted(() => vi.fn());

import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
Object.assign(vaultHooksSeams, {
  useVault: () => ({ items: [], folders: [] }),
  useVaultStore: () => ({ applyImport, importSealed: vi.fn() }),
});

import { ImportKey } from "./ImportKey.js";

function makeFile(name: string, contents: string): File {
  const file = new File([contents], name, { type: "text/plain" });
  // jsdom's File does not implement Blob#text; the pipeline awaits it.
  Object.defineProperty(file, "text", {
    value: () => Promise.resolve(contents),
  });
  return file;
}

beforeEach(() => {
  applyImport.mockResolvedValue(2);
});

afterEach(() => {
  cleanup();
  discardPendingImport();
  vi.clearAllMocks();
});

describe("a file chosen at the door, once the vault it was for is open", () => {
  it("opens the Import sheet on it without another choice", async () => {
    holdPendingImport(makeFile("app.env", "API_KEY=sk-123\nOTHER_TOKEN=abc\n"));
    render(<ImportKey />);

    expect(
      await screen.findByRole("dialog", { name: "Import items" }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("combobox", { name: "Read it as" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^Import 2 items/i }),
    ).toBeTruthy();
    // Taken, not copied: a later Import key does not open it a second time.
    expect(peekPendingImport()).toBeNull();
  });

  it("writes nothing until the sheet's own commit is pressed", async () => {
    holdPendingImport(makeFile("app.env", "API_KEY=sk-123\n"));
    render(<ImportKey />);
    await screen.findByRole("combobox", { name: "Read it as" });
    expect(applyImport).not.toHaveBeenCalled();
  });

  it("leaves the key as it was when nothing waits", () => {
    render(<ImportKey />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Import items" })).toBeTruthy();
  });
});
