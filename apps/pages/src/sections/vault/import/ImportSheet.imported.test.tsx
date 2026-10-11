/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const applyImport = vi.hoisted(() => vi.fn());

import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
Object.assign(vaultHooksSeams, {
  useVault: () => ({ items: [], folders: [] }),
  useVaultStore: () => ({ applyImport, importSealed: vi.fn() }),
});

import { ImportSheet } from "./ImportSheet.js";

function makeFile(name: string, contents: string): File {
  const file = new File([contents], name, { type: "text/plain" });
  // jsdom's File does not implement Blob#text; the pipeline awaits it.
  Object.defineProperty(file, "text", {
    value: () => Promise.resolve(contents),
  });
  return file;
}

function open(onImported: () => void) {
  render(
    <ImportSheet
      file={makeFile("app.env", "API_KEY=sk-123\nOTHER_TOKEN=abc\n")}
      onRepick={() => undefined}
      onClose={() => undefined}
      onImported={onImported}
    />,
  );
}

describe("the Import sheet tells whoever opened it when the items are in the vault", () => {
  beforeEach(() => {
    applyImport.mockResolvedValue(2);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("calls back once, after the merge has been written, and not before", async () => {
    const onImported = vi.fn();
    open(onImported);
    const commit = await screen.findByRole("button", {
      name: /Import 2 items/i,
    });
    expect(onImported).not.toHaveBeenCalled();
    await userEvent.click(commit);
    expect(await screen.findByText("Imported")).toBeTruthy();
    expect(applyImport).toHaveBeenCalledTimes(1);
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("does not call back when the merge was refused", async () => {
    applyImport.mockRejectedValue(new Error("The vault is locked."));
    const onImported = vi.fn();
    open(onImported);
    await userEvent.click(
      await screen.findByRole("button", { name: /Import 2 items/i }),
    );
    await screen.findByRole("img", { name: /locked/i });
    expect(onImported).not.toHaveBeenCalled();
  });

  it("is optional: a sheet opened without it imports as before", async () => {
    render(
      <ImportSheet
        file={makeFile("app.env", "API_KEY=sk-123\n")}
        onRepick={() => undefined}
        onClose={() => undefined}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Import 1 item/i }),
    );
    expect(await screen.findByText("Imported")).toBeTruthy();
  });
});
