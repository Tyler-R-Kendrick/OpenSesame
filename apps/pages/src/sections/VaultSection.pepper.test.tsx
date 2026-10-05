/** @vitest-environment jsdom */
import { enablePepper } from "@opensesame/app-core/lib/vault/generators/index.js";
import { type VaultItem, passwordMethod } from "@opensesame/vault-core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeymapHandler } from "../lib/keymap.js";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { VaultSection } from "./VaultSection.js";
import { vaultTreeSeams } from "./vault/VaultTree.js";
import { makeAccount } from "./vault/section-items.test-support.js";

const copySecret = vi.fn();
type Fixture = { items: VaultItem[] };
const vault: Fixture = { items: [] };
Object.assign(vaultHooksSeams, {
  useVault: () => ({ items: vault.items, folders: [], header: null }),
  useVaultStore: () => ({}),
  useCopySecret: () => copySecret,
});
Object.assign(vaultTreeSeams, {
  activeTomb: () => "personal",
  loadCollapsed: async (): Promise<string[]> => [],
  saveCollapsed: async () => undefined,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderList() {
  return render(
    <MemoryRouter initialEntries={["/vault"]}>
      <Routes>
        <Route path="/vault" element={<VaultSection />}>
          <Route index element={<div>welcome pane</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function pressY() {
  const handler = createKeymapHandler({ navigate: vi.fn(), showHelp: vi.fn() });
  act(() => {
    handler(new KeyboardEvent("keydown", { key: "y", cancelable: true }));
  });
}

describe("VaultSection copy of an account password", () => {
  it("copies a stored password with no question asked", async () => {
    vault.items = [makeAccount({ password: "hunter2hunter2hunter2" })];
    renderList();
    pressY();
    await waitFor(() =>
      expect(copySecret).toHaveBeenCalledWith("hunter2hunter2hunter2"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks for the pepper before copying, and copies nothing on cancel", async () => {
    const plain = makeAccount({ password: "pepper-me-please" });
    const method = passwordMethod(plain);
    if (!method) throw new Error("fixture");
    const sealed = await enablePepper(
      plain.id,
      method,
      "pepper-me-please",
      "right",
    );
    vault.items = [{ ...plain, methods: [sealed] }];
    renderList();
    pressY();
    await screen.findByRole("dialog", { name: "Use pepper" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(copySecret).not.toHaveBeenCalled();
    pressY();
    const field = await screen.findByLabelText("Pepper");
    fireEvent.change(field, { target: { value: "right" } });
    fireEvent.click(screen.getByRole("button", { name: "Use pepper" }));
    await waitFor(() =>
      expect(copySecret).toHaveBeenCalledWith("pepper-me-please"),
    );
  }, 20_000);
});
