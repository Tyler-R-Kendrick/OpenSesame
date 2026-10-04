/**
 * The restore card's choice about the backup's device identity (ADR 0160
 * §5a): offered only to a vault that has done nothing yet, off until the
 * person chooses it, and handed to the store as the person's decision.
 */
import {
  type Folder,
  type VaultItem,
  createItem,
} from "@opensesame/vault-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type VaultFixture = {
  current: {
    guest: boolean;
    tomb: string;
    items: VaultItem[];
    folders: Folder[];
  };
};
const empty = { guest: false, tomb: "personal", items: [], folders: [] };
const vault: VaultFixture = { current: empty };
const importSealed = vi.hoisted(() => vi.fn());

import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => ({ applyImport: vi.fn(), importSealed }),
});

import { ImportKey } from "./ImportKey.js";

const BACKUP = JSON.stringify({
  format: "opensesame-vault-export",
  v: 1,
  tomb: "personal",
  header: { v: 1, createdAt: "2026-09-01T00:00:00.000Z" },
  body: { ivB64: "aXY=", ctB64: "Y3Q=" },
});
const CHOICE = "Also take its device identity";

function makeFile(name: string, contents: string): File {
  const file = new File([contents], name, { type: "application/json" });
  // jsdom's File does not implement Blob#text; the pipeline awaits it.
  Object.defineProperty(file, "text", {
    value: () => Promise.resolve(contents),
  });
  return file;
}

async function openCard() {
  render(<ImportKey />);
  fireEvent.change(screen.getByLabelText("Choose a file to import"), {
    target: { files: [makeFile("vault.json", BACKUP)] },
  });
  return screen.findByLabelText<HTMLInputElement>("Master password");
}

/** The browser has Web Locks, as every browser this runs in does. */
function withWebLocks(): void {
  Object.defineProperty(navigator, "locks", {
    value: { request: vi.fn() },
    configurable: true,
  });
}

beforeEach(() => {
  importSealed.mockReset();
  vault.current = empty;
  withWebLocks();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "locks");
});

describe("taking the backup's device identity", () => {
  it("is offered to a vault that has done nothing, and is off until the person chooses it", async () => {
    await openCard();
    const box = screen.getByRole<HTMLInputElement>("checkbox", {
      name: CHOICE,
    });
    expect(box.checked).toBe(false);
  });

  it("restores without the identity by default", async () => {
    importSealed.mockResolvedValue(1);
    await userEvent.type(await openCard(), "pw");
    await userEvent.click(
      screen.getByRole("button", { name: "Restore items" }),
    );
    expect(importSealed.mock.calls.at(-1)?.[2]).toEqual({
      adoptIdentity: false,
    });
  });

  it("restores with the identity once the person chooses it", async () => {
    importSealed.mockResolvedValue(1);
    await userEvent.type(await openCard(), "pw");
    await userEvent.click(screen.getByRole("checkbox", { name: CHOICE }));
    await userEvent.click(
      screen.getByRole("button", { name: "Restore items" }),
    );
    expect(importSealed.mock.calls.at(-1)?.[2]).toEqual({
      adoptIdentity: true,
    });
  });

  it("is not offered to a vault that already holds items or folders, and sends no choice", async () => {
    for (const held of [
      { items: [createItem("note", "held")], folders: [] },
      {
        items: [],
        folders: [
          { id: "f", name: "Work", createdAt: "2026-09-01T00:00:00.000Z" },
        ],
      },
    ]) {
      cleanup();
      vault.current = { ...empty, ...held };
      importSealed.mockResolvedValue(1);
      await userEvent.type(await openCard(), "pw");
      expect(screen.queryByRole("checkbox", { name: CHOICE })).toBeNull();
      await userEvent.click(
        screen.getByRole("button", { name: "Restore items" }),
      );
      expect(importSealed.mock.calls.at(-1)?.[2]).toEqual({
        adoptIdentity: false,
      });
    }
  });
});

describe("where a vault cannot take an identity at all", () => {
  async function restoreAndCheckNoChoice(): Promise<void> {
    importSealed.mockResolvedValue(1);
    await userEvent.type(await openCard(), "pw");
    expect(screen.queryByRole("checkbox", { name: CHOICE })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Restore items" }),
    );
    expect(importSealed.mock.calls.at(-1)?.[2]).toEqual({
      adoptIdentity: false,
    });
  }

  it("draws no choice for a guest, and restores without one", async () => {
    vault.current = { ...empty, guest: true };
    await restoreAndCheckNoChoice();
  });

  it("draws no choice for the guest tomb or the scratch tomb either", async () => {
    vault.current = { ...empty, tomb: "guest" };
    await restoreAndCheckNoChoice();
  });

  it("draws no choice where the browser has no Web Locks, and restores without one", async () => {
    Reflect.deleteProperty(navigator, "locks");
    await restoreAndCheckNoChoice();
  });
});
