/** @vitest-environment jsdom */

/**
 * SURFACE-08 — what a person is offered when they create an item.
 *
 * Passkey and certificate records are always on: every plan carries them.
 * Drops belong to the Sharing feature, which the Personal preset does not
 * select, so a Personal plan offers passkeys and certificates but no drop.
 * This walks the surfaces a person actually creates through — the type
 * picker in the new-item editor and the kind filters in the vault rail —
 * and proves the drop is not offered, while a drop already sealed in the
 * vault still opens.
 *
 * The parsers are untouched by composition on purpose: a plan decides what
 * may be *made*, never what may be *read*, or a person who turned a
 * feature off would lose the records they already had.
 */

import { describeCapability } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { PRESETS } from "@opensesame/app-core/lib/capabilities/presets.js";
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import { LEGACY_ITEM_KINDS } from "@opensesame/app-core/lib/contributions.test-support.js";
import {
  CORE_ITEM_KINDS,
  itemKindsSnapshot,
} from "@opensesame/app-core/lib/item-kinds.js";
import {
  type Folder,
  type VaultItem,
  createItem,
} from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
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

const vault = vi.hoisted(() => ({
  current: { items: [] as VaultItem[], folders: [] as Folder[] },
}));
const saveItem = vi.hoisted(() => vi.fn(async () => undefined));

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => ({ saveItem }),
  useCopySecret: () => vi.fn().mockResolvedValue("copied"),
});

import { VaultRail } from "../../components/VaultRail.js";
import { ItemEditor } from "./ItemEditor.js";

/**
 * The item kinds a Personal plan's capabilities contribute: the always-on
 * ones, plus whatever the preset pre-selects. Derived from the catalog and
 * the preset rather than restated, so a change to either fails here instead
 * of quietly widening the creation menu.
 */
const PERSONAL_SELECTED = new Set(
  PRESETS.find((preset) => preset.id === "personal")?.defaultSelected ?? [],
);
const ITEM_KIND_OWNERS = {
  "vault.passkey-records": LEGACY_ITEM_KINDS[0],
  "sharing.drops": LEGACY_ITEM_KINDS[1],
  "vault.certificate-records": LEGACY_ITEM_KINDS[2],
} as const;
const inPersonalPlan = (capability: string) =>
  describeCapability(capability)?.tier === "core" ||
  PERSONAL_SELECTED.has(capability);

function registerPersonalPlan(): () => void {
  const revokes = Object.entries(ITEM_KIND_OWNERS)
    .filter(([capability]) => inPersonalPlan(capability))
    .map(([, kind]) => registerContributionForTest("item-kind", kind));
  return () => {
    for (const revoke of revokes) revoke();
  };
}

function drop(): VaultItem {
  return { ...createItem("drop", "Shared wifi"), id: "itm_drop" };
}

function renderEditor(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/vault/new/:kind?" element={<ItemEditor mode="new" />} />
        <Route
          path="/vault/:itemId/edit"
          element={<ItemEditor mode="edit" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function typeOptions(): string[] {
  const select = screen.getByLabelText<HTMLSelectElement>("Type");
  return [...select.options].map((option) => option.value);
}

let revokePlan = () => {};

describe("what a Personal plan offers when an item is created", () => {
  beforeEach(() => {
    vault.current = { items: [drop()], folders: [] };
    revokePlan = registerPersonalPlan();
  });
  afterEach(() => {
    revokePlan();
    cleanup();
  });

  it("carries passkeys and certificates always, and selects no sharing", () => {
    expect(inPersonalPlan("vault.passkey-records")).toBe(true);
    expect(inPersonalPlan("vault.certificate-records")).toBe(true);
    expect(inPersonalPlan("sharing.drops")).toBe(false);
    expect(PERSONAL_SELECTED.has("wallet.spending")).toBe(false);
  });

  it("leaves the drop type out of the new-item type picker", () => {
    renderEditor("/vault/new");
    const offered = typeOptions();
    for (const core of CORE_ITEM_KINDS) {
      expect(offered, core.id).toContain(core.id);
    }
    expect(offered).toContain("passkey");
    expect(offered).toContain("certificate");
    expect(offered).not.toContain("drop");
  });

  it("leaves the drop filter out of the vault rail", () => {
    const kinds = itemKindsSnapshot();
    expect(kinds.map((kind) => kind.id)).toEqual([
      "login",
      "passkey",
      "card",
      "secret",
      "note",
      "certificate",
    ]);
    const { container } = render(
      <MemoryRouter>
        <VaultRail
          items={vault.current.items}
          folders={[]}
          counts={{
            all: 1,
            favorites: 0,
            trash: 0,
            byKind: new Map([["drop", 1]]),
            byFolder: new Map(),
          }}
          selectedTo="/vault"
          kinds={kinds}
        />
      </MemoryRouter>,
    );
    const filters = [
      ...container.querySelectorAll<HTMLAnchorElement>('a[href^="/vault?f="]'),
    ].map((link) => link.getAttribute("href"));
    expect(filters).toContain("/vault?f=passkey");
    expect(filters).toContain("/vault?f=certificate");
    expect(filters).not.toContain("/vault?f=drop");
  });

  it("still finds the drop already sealed in this vault", () => {
    renderEditor("/vault/itm_drop/edit");
    // A drop is never edited, with or without Sharing; the record is still
    // read and the editor points back at it rather than reading as missing.
    expect(screen.getByText("Drops cannot be edited")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Back to the drop" })
        .getAttribute("href"),
    ).toBe("/vault/itm_drop");
    expect(vault.current.items[0]?.kind).toBe("drop");
  });

  it("offers the drop type again once Sharing is switched on", () => {
    const revoke = registerContributionForTest(
      "item-kind",
      ITEM_KIND_OWNERS["sharing.drops"],
    );
    renderEditor("/vault/new");
    expect(typeOptions()).toContain("drop");
    revoke();
  });
});

afterAll(() => {
  Object.assign(vaultHooksSeams, originalVaultHooksSeams);
});
