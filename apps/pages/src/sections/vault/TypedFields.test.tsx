import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { MemoryRouter, Route, Routes } from "react-router";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  itemTypeRegistry,
  newValues,
  syncInstalledTypes,
} from "../../lib/vault/item-types.js";
import type { Folder, VaultItem } from "../../lib/vault/model.js";
import { createTypedItem } from "../../lib/vault/model.js";

/**
 * The generic ceremony, end to end (ADR 0087).
 *
 * A type this build has never heard of is installed at runtime, and the editor
 * and the detail view draw it from its definition alone — no per-type code, no
 * rebuild. The concealment rules are checked here too, because the renderer is
 * the last place a declared secret could escape into the clear.
 */

type VaultFixture = { current: { items: VaultItem[]; folders: Folder[] } };

const vault = vi.hoisted(
  (): VaultFixture => ({ current: { items: [], folders: [] } }),
);
const saveItem = vi.hoisted(() => vi.fn<(item: VaultItem) => Promise<void>>());

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => ({
    saveItem,
    trashItem: vi.fn(),
    toggleFavorite: vi.fn(),
  }),
  useCopySecret: () => vi.fn().mockResolvedValue("copied"),
});

import { ItemDetail } from "./ItemDetail.js";
import { ItemEditor } from "./ItemEditor.js";

const BANK_LOCKER = JSON.stringify({
  apiVersion: "opensesame.dev/v1alpha1",
  kind: "VaultItemType",
  metadata: {
    id: "safe-deposit",
    version: "1.0.0",
    publisher: "https://community.test",
  },
  spec: {
    title: "Safe deposit box",
    plural: "Safe deposit boxes",
    extension: ".box",
    summary: "A box number, the branch that holds it, and the key code.",
    categories: ["finance"],
    sections: [
      {
        id: "box",
        title: "Box",
        fields: [
          { id: "branch", type: "string", label: "Branch", required: true },
          { id: "boxNumber", type: "string", label: "Box number" },
          { id: "keyCode", type: "concealed", label: "Key code" },
        ],
      },
    ],
    native: {
      secret: "keyCode",
      trailer: [
        { key: "branch", field: "branch" },
        { key: "box_number", field: "boxNumber" },
      ],
    },
    cxf: { credential: "custom-fields" },
    subtitle: ["branch", "boxNumber"],
    search: ["branch"],
  },
});

function makeBoxItem(): VaultItem {
  const definition = itemTypeRegistry().get("safe-deposit");
  if (definition === undefined)
    throw new Error("safe-deposit is not installed");
  return {
    ...createTypedItem(
      definition,
      {
        ...newValues(definition),
        branch: "High Street",
        boxNumber: "114",
        keyCode: "8891",
      },
      "Deposit box",
    ),
    id: "itm_box",
  };
}

function renderEditor(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/vault/new/:kind" element={<ItemEditor mode="new" />} />
        <Route
          path="/vault/:itemId/edit"
          element={<ItemEditor mode="edit" />}
        />
        <Route path="*" element={<div>navigated away</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderDetail(itemId: string) {
  return render(
    <MemoryRouter initialEntries={[`/vault/${itemId}`]}>
      <Routes>
        <Route path="/vault/:itemId" element={<ItemDetail />} />
        <Route path="*" element={<div>navigated away</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vault.current = { items: [], folders: [] };
  saveItem.mockReset();
  saveItem.mockResolvedValue();
  syncInstalledTypes({ "safe-deposit": BANK_LOCKER });
});

afterEach(() => {
  cleanup();
  syncInstalledTypes({});
});

afterAll(() => {
  Object.assign(vaultHooksSeams, originalVaultHooksSeams);
});

describe("the editor for a type installed at runtime", () => {
  it("offers the type in the picker beside the built-in ones", () => {
    renderEditor("/vault/new/login");
    const picker = screen.getByLabelText("Type");
    const options = [...picker.querySelectorAll("option")].map(
      (option) => option.value,
    );
    expect(options).toContain("safe-deposit");
    expect(options).toContain("login");
  });

  it("draws the fields the definition declares, with no per-type code", () => {
    renderEditor("/vault/new/safe-deposit");
    expect(screen.getByText("Box")).toBeTruthy();
    expect(screen.getByLabelText("Branch *")).toBeTruthy();
    expect(screen.getByLabelText("Box number")).toBeTruthy();
    expect(screen.getByLabelText("Key code")).toBeTruthy();
  });

  it("conceals a concealed field until it is revealed", () => {
    renderEditor("/vault/new/safe-deposit");
    const keyCode = screen.getByLabelText("Key code");
    expect(keyCode.getAttribute("type")).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Reveal key code" }));
    expect(screen.getByLabelText("Key code").getAttribute("type")).toBe("text");
  });

  it("refuses to save with a required field empty, as the star promises", async () => {
    renderEditor("/vault/new/safe-deposit");
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Deposit box" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Branch"),
    );
    expect(saveItem).not.toHaveBeenCalled();
  });

  it("saves the values under the type id", async () => {
    renderEditor("/vault/new/safe-deposit");
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Deposit box" },
    });
    fireEvent.change(screen.getByLabelText("Branch *"), {
      target: { value: "High Street" },
    });
    fireEvent.change(screen.getByLabelText("Key code"), {
      target: { value: "8891" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const saved = saveItem.mock.calls[0]?.[0];
    expect(saved?.kind).toBe("typed");
    if (saved?.kind !== "typed") return;
    expect(saved.typeId).toBe("safe-deposit");
    expect(saved.values.branch).toBe("High Street");
    expect(saved.values.keyCode).toBe("8891");
  });
});

describe("the detail view for a type installed at runtime", () => {
  it("shows the declared fields and the type's own title", () => {
    vault.current = { items: [makeBoxItem()], folders: [] };
    renderDetail("itm_box");
    expect(screen.getByText("Safe deposit box")).toBeTruthy();
    expect(screen.getByText("High Street")).toBeTruthy();
    expect(screen.getByText("114")).toBeTruthy();
  });

  it("never renders a concealed value until it is revealed", () => {
    vault.current = { items: [makeBoxItem()], folders: [] };
    renderDetail("itm_box");
    expect(screen.queryByText("8891")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal key code" }));
    expect(screen.getByText("8891")).toBeTruthy();
  });

  it("keeps an item whose definition is gone, and conceals every value", () => {
    const item = makeBoxItem();
    syncInstalledTypes({});
    vault.current = { items: [item], folders: [] };
    renderDetail("itm_box");
    expect(screen.getByText("Stored fields")).toBeTruthy();
    // Every value is still there, and none of it is on screen un-revealed:
    // without the definition there is no way to know which were concealed.
    expect(screen.queryByText("High Street")).toBeNull();
    expect(screen.queryByText("8891")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal branch" }));
    expect(screen.getByText("High Street")).toBeTruthy();
  });
});
