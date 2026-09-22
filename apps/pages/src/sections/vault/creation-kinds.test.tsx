/** @vitest-environment jsdom */

/**
 * SURFACE-08 — what a household is offered when it creates an item.
 *
 * The Family preset selects `vault.passkey-records`, `sharing.household`,
 * `sharing.drops` and `support.guided-help` and nothing else, so certificate
 * records, the connectors capability and the wallet are all absent from that
 * plan. This walks the surfaces a person actually creates through — the type
 * picker in the new-item editor and the kind filters in the vault rail — and
 * proves those three are not offered, while a certificate already sealed in
 * the vault still opens and still reads back every field.
 *
 * The parsers are untouched by composition on purpose: a plan decides what
 * may be *made*, never what may be *read*, or a household that turned a
 * capability off would lose the records it already had.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESETS } from "../../lib/capabilities/presets.js";
import { LEGACY_ITEM_KINDS } from "../../lib/contributions.test-support.js";
import { registerContributionForTest } from "../../lib/contributions.js";
import { CORE_ITEM_KINDS, itemKindsSnapshot } from "../../lib/item-kinds.js";
import { createItem } from "../../lib/vault/model.js";
import type {
  CertificateItem,
  Folder,
  VaultItem,
} from "../../lib/vault/model.js";

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
 * The item kinds a Family plan's approved capabilities contribute. Derived
 * from the preset rather than restated, so a change to what Family selects
 * fails here instead of quietly widening the creation menu.
 */
const FAMILY_SELECTED = new Set(
  PRESETS.find((preset) => preset.id === "family")?.defaultSelected ?? [],
);
const FAMILY_ITEM_KINDS = {
  "vault.passkey-records": LEGACY_ITEM_KINDS[0],
  "sharing.drops": LEGACY_ITEM_KINDS[1],
  "vault.certificate-records": LEGACY_ITEM_KINDS[2],
} as const;

function registerFamilyPlan(): () => void {
  const revokes = Object.entries(FAMILY_ITEM_KINDS)
    .filter(([capability]) => FAMILY_SELECTED.has(capability))
    .map(([, kind]) => registerContributionForTest("item-kind", kind));
  return () => {
    for (const revoke of revokes) revoke();
  };
}

function certificate(): CertificateItem {
  return {
    ...createItem("certificate", "Router TLS"),
    id: "itm_cert",
    commonName: "router.home.arpa",
    certificatePem: "-----BEGIN CERTIFICATE-----\nsealed\n-----END-----",
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\nsealed\n-----END-----",
  } as CertificateItem;
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

describe("what a Family plan offers when an item is created", () => {
  beforeEach(() => {
    vault.current = { items: [certificate()], folders: [] };
    revokePlan = registerFamilyPlan();
  });
  afterEach(() => {
    revokePlan();
    cleanup();
  });

  it("selects passkeys and drops, and no certificate capability", () => {
    expect(FAMILY_SELECTED.has("vault.passkey-records")).toBe(true);
    expect(FAMILY_SELECTED.has("sharing.drops")).toBe(true);
    expect(FAMILY_SELECTED.has("vault.certificate-records")).toBe(false);
    expect(FAMILY_SELECTED.has("connectors.external")).toBe(false);
    expect(FAMILY_SELECTED.has("wallet.spending")).toBe(false);
  });

  it("leaves the certificate type out of the new-item type picker", () => {
    renderEditor("/vault/new/login");
    const offered = typeOptions();
    for (const core of CORE_ITEM_KINDS) {
      expect(offered, core.id).toContain(core.id);
    }
    expect(offered).toContain("passkey");
    expect(offered).toContain("drop");
    expect(offered).not.toContain("certificate");
  });

  it("leaves the certificate filter out of the vault rail", () => {
    const kinds = itemKindsSnapshot();
    expect(kinds.map((kind) => kind.id)).toEqual([
      "login",
      "passkey",
      "card",
      "secret",
      "drop",
      "note",
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
            byKind: new Map([["certificate", 1]]),
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
    expect(filters).toContain("/vault?f=drop");
    expect(filters).not.toContain("/vault?f=certificate");
  });

  it("still opens the certificate already sealed in this vault", () => {
    renderEditor("/vault/itm_cert/edit");
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
      "Router TLS",
    );
    // The record is read by the same parser it always was; only creating a
    // new one is gated, so nothing a household already holds is lost.
    expect(screen.getByText(".cert")).toBeTruthy();
    expect(vault.current.items[0]?.kind).toBe("certificate");
  });

  it("offers the certificate type again once that capability is approved", () => {
    const revoke = registerContributionForTest(
      "item-kind",
      FAMILY_ITEM_KINDS["vault.certificate-records"],
    );
    renderEditor("/vault/new/login");
    expect(typeOptions()).toContain("certificate");
    revoke();
  });
});

afterEach(() => {
  Object.assign(vaultHooksSeams, originalVaultHooksSeams);
});
