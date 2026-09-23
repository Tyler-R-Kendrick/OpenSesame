import {
  itemTypeRegistry,
  newValues,
  syncInstalledTypes,
} from "@opensesame/app-core/lib/vault/item-types.js";
import {
  createItem,
  createTypedItem,
} from "@opensesame/app-core/lib/vault/model.js";
import type {
  Folder,
  VaultItem,
} from "@opensesame/app-core/lib/vault/model.js";
import type { JsonObject } from "@opensesame/os-domain";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

/**
 * A plugin-defined type is a type like any other in the vault list (ADR 0087
 * §1): it gets its own filter road, its own breadcrumb, and the filter selects
 * on the type id rather than on the storage discriminant. Before this, every
 * community type collapsed into one undifferentiated "Items" bucket no filter
 * could reach.
 */

/** The filters live behind one key on a phone. Open it and read the roads. */
function openFilters(): void {
  fireEvent.click(screen.getByRole("button", { name: /^Filter — / }));
}

type VaultHarness = {
  current: { items: VaultItem[]; folders: Folder[]; header: JsonObject | null };
};

const vault = vi.hoisted(
  (): VaultHarness => ({ current: { items: [], folders: [], header: null } }),
);

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => ({ purgeItem: vi.fn(), trashItem: vi.fn() }),
  useCopySecret: () => vi.fn().mockResolvedValue("copied"),
});

import { VaultSection } from "../VaultSection.js";

const SAFE_DEPOSIT = JSON.stringify({
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
    summary: "A box number and the branch that holds it.",
    categories: ["finance"],
    sections: [
      {
        id: "box",
        title: "Box",
        fields: [
          { id: "branch", type: "string", label: "Branch" },
          { id: "keyCode", type: "concealed", label: "Key code" },
        ],
      },
    ],
    native: {
      secret: "keyCode",
      trailer: [{ key: "branch", field: "branch" }],
    },
    cxf: { credential: "custom-fields" },
    subtitle: ["branch"],
    search: ["branch"],
  },
});

function boxItem(id: string, branch: string): VaultItem {
  const definition = itemTypeRegistry().get("safe-deposit");
  if (definition === undefined)
    throw new Error("safe-deposit is not installed");
  return {
    ...createTypedItem(
      definition,
      { ...newValues(definition), branch, keyCode: "8891" },
      `Box ${branch}`,
    ),
    id,
  };
}

function renderSection(initial = "/vault") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/vault" element={<VaultSection />}>
          <Route index element={<div>welcome pane</div>} />
          <Route path=":itemId" element={<div>detail pane</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  syncInstalledTypes({ "safe-deposit": SAFE_DEPOSIT });
  const login = createItem("login", "Webmail");
  login.id = "itm_login";
  vault.current = {
    items: [login, boxItem("itm_box", "High Street")],
    folders: [],
    header: null,
  };
});

afterEach(() => {
  cleanup();
  syncInstalledTypes({});
});

afterAll(() => {
  Object.assign(vaultHooksSeams, originalVaultHooksSeams);
});

describe("the vault list for a type installed at runtime", () => {
  it("gives the type its own filter road, under its own plural", () => {
    renderSection();
    openFilters();
    expect(
      screen.getByRole("link", { name: /Safe deposit boxes/ }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /Logins/ })).toBeTruthy();
  });

  it("filters on the type id, not on the storage discriminant", () => {
    renderSection("/vault?f=safe-deposit");
    expect(screen.getByText("Box High Street")).toBeTruthy();
    expect(screen.queryByText("Webmail")).toBeNull();
  });

  it("leaves a built-in filter selecting only its own items", () => {
    renderSection("/vault?f=login");
    expect(screen.getByText("Webmail")).toBeTruthy();
    expect(screen.queryByText("Box High Street")).toBeNull();
  });

  it("offers no road for a type this vault holds no items of", () => {
    renderSection();
    openFilters();
    expect(screen.queryByRole("link", { name: /Passkeys/ })).toBeNull();
  });

  it("still lists an item whose definition is not installed here", () => {
    const orphan = vault.current.items[1];
    syncInstalledTypes({});
    if (orphan === undefined) throw new Error("expected the box item");
    vault.current = { items: [orphan], folders: [], header: null };
    renderSection();
    expect(screen.getByText("Box High Street")).toBeTruthy();
    openFilters();
    // The road falls back to the raw type id rather than the item vanishing.
    expect(screen.getByRole("link", { name: /safe-deposit/ })).toBeTruthy();
  });
});
