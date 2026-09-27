import { applyManifestPlan } from "@opensesame/app-core/lib/vault/body-edits.js";
import type { ManifestMergePlan } from "@opensesame/app-core/lib/vault/store-sync.js";
import {
  type Folder,
  type VaultItem,
  createItem,
  emptyBody,
} from "@opensesame/vault-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type VaultFixture = { current: { items: VaultItem[]; folders: Folder[] } };
const vault: VaultFixture = { current: { items: [], folders: [] } };
const applyImport = vi.hoisted(() => vi.fn());
const importSealed = vi.hoisted(() => vi.fn());
/** Writes the plan into the fixture the way the store's one mutation does. */
const applyManifestMerge = vi.hoisted(() => vi.fn());

import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => ({ applyImport, importSealed, applyManifestMerge }),
});

import { ImportKey } from "./ImportKey.js";

const MANIFEST = JSON.stringify([
  {
    path: "Dev/GitHub",
    secret: "correct-horse-7",
    trailer: '{"kind":"login","username":"octo"}\n',
  },
  {
    path: "Deploy hook",
    secret: "whsec_fixture",
    trailer: '{"kind":"secret"}\n',
  },
]);

function manifestFile(): File {
  const file = new File([MANIFEST], "manifest.json", {
    type: "application/json",
  });
  Object.defineProperty(file, "text", {
    value: () => Promise.resolve(MANIFEST),
  });
  return file;
}

function pickFile(file: File) {
  const input = screen.getByLabelText("Choose a file to import");
  fireEvent.change(input, { target: { files: [file] } });
}

describe("Import key, store path manifest (ADR 0037 §6)", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [] };
    applyManifestMerge.mockImplementation(async (plan: ManifestMergePlan) => {
      const body = { ...emptyBody(), ...vault.current };
      applyManifestPlan(body, plan);
      vault.current = { items: body.items, folders: body.folders };
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("previews a manifest as a by-path merge and never duplicates on a second import", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ImportKey />);

    pickFile(manifestFile());
    const sheet = await screen.findByRole("dialog", { name: "Import items" });
    await within(sheet).findByText("OpenSesame store path manifest");
    // No format picker: a manifest is recognised, not guessed at.
    expect(within(sheet).queryByRole("combobox")).toBeNull();
    await user.click(
      within(sheet).getByRole("button", { name: "Merge 2 entries" }),
    );
    await within(sheet).findByText("Imported");
    expect(applyImport).not.toHaveBeenCalled();
    expect(vault.current.items.map((item) => item.name).sort()).toEqual([
      "Deploy hook",
      "GitHub",
    ]);
    await user.click(within(sheet).getByRole("button", { name: "Done" }));

    rerender(<ImportKey />);
    pickFile(manifestFile());
    const again = await screen.findByRole("dialog", { name: "Import items" });
    const commit = await within(again).findByRole("button", {
      name: "Nothing to merge",
    });
    expect(commit).toHaveProperty("disabled", true);
    expect(within(again).getByText("Already here").nextSibling).toHaveProperty(
      "textContent",
      "2",
    );
    expect(vault.current.items).toHaveLength(2);
    expect(vault.current.folders.map((folder) => folder.name)).toEqual(["Dev"]);
  });

  it("leaves a card at a manifest path as it is", async () => {
    const card = createItem("card", "Deploy hook");
    card.number = "4111111111111111";
    vault.current = { items: [card], folders: [] };
    render(<ImportKey />);

    pickFile(manifestFile());
    const sheet = await screen.findByRole("dialog", { name: "Import items" });
    await within(sheet).findByText("Kept as is");
    await userEvent
      .setup()
      .click(within(sheet).getByRole("button", { name: "Merge 1 entry" }));
    await within(sheet).findByText("Imported");
    expect(
      vault.current.items.find((item) => item.id === card.id),
    ).toStrictEqual(card);
  });
});
