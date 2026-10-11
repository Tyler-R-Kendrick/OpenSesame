/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const importSealed = vi.hoisted(() => vi.fn());

import { STALE_BUILD } from "@opensesame/app-core/lib/chunk-load.js";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
Object.assign(vaultHooksSeams, {
  useVault: () => ({ items: [], folders: [] }),
  useVaultStore: () => ({ applyImport: vi.fn(), importSealed }),
});

import { pwaUpdateSeams } from "../../../lib/pwa-update.js";
import { ImportSheet } from "./ImportSheet.js";

const update = vi.fn(async () => undefined);
const original = { ...pwaUpdateSeams };

function makeFile(name: string, contents: string): File {
  const file = new File([contents], name, { type: "text/plain" });
  // jsdom's File does not implement Blob#text; the pipeline awaits it.
  Object.defineProperty(file, "text", {
    value: () => Promise.resolve(contents),
  });
  return file;
}

const PIN_BACKUP = JSON.stringify({
  format: "opensesame-offline-backup",
  v: 1,
  projectId: null,
  exportedAt: "2026-10-11T04:54:40.456Z",
  vault: {
    header: {
      v: 1,
      createdAt: "2026-10-11T04:18:54.410Z",
      unlocks: {
        pin: {
          kdf: { alg: "PBKDF2-SHA256", saltB64: "c2FsdA==", iterations: 1000 },
          wrap: { ivB64: "aXY=", ctB64: "Y3Q=" },
        },
      },
    },
    body: { ivB64: "aXY=", ctB64: "Y3Q=" },
  },
  syncBlobs: [],
  deploymentSealUsed: false,
});

describe("a restore from a page the host has since replaced", () => {
  beforeEach(() => {
    Object.assign(pwaUpdateSeams, {
      serviceWorkerContainer: () => ({
        getRegistration: async () => ({ update }),
      }),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    Object.assign(pwaUpdateSeams, original);
  });

  it("says the page is out of date, never the browser's own words, and asks for the new build", async () => {
    importSealed.mockRejectedValue(
      new TypeError(
        "Failed to fetch dynamically imported module: https://example.test/OpenSesame/assets/device-identity-carry-Bvwzak28.js",
      ),
    );
    render(
      <ImportSheet
        file={makeFile("backup.json", PIN_BACKUP)}
        onRepick={() => undefined}
        onClose={() => undefined}
      />,
    );
    await userEvent.type(await screen.findByLabelText("PIN"), "48291037");
    await userEvent.click(
      screen.getByRole("button", { name: "Restore items" }),
    );
    expect(await screen.findByRole("img", { name: STALE_BUILD })).toBeTruthy();
    expect(screen.queryByText(/dynamically imported/)).toBeNull();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a new build when the PIN was simply wrong", async () => {
    importSealed.mockRejectedValue(new Error("Wrong PIN."));
    render(
      <ImportSheet
        file={makeFile("backup.json", PIN_BACKUP)}
        onRepick={() => undefined}
        onClose={() => undefined}
      />,
    );
    await userEvent.type(await screen.findByLabelText("PIN"), "00000000");
    await userEvent.click(
      screen.getByRole("button", { name: "Restore items" }),
    );
    expect(await screen.findByRole("img", { name: "Wrong PIN." })).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });
});
