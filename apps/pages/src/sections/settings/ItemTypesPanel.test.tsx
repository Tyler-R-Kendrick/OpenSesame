import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
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
  installItemType,
  itemTypeRegistry,
  syncInstalledTypes,
  uninstallItemType,
} from "../../lib/vault/item-types.js";
import type { Folder, VaultItem } from "../../lib/vault/model.js";

/**
 * Installing a type is a data write, not a build (ADR 0087 §7). The panel
 * proves that end to end: paste a definition this build has never seen, and
 * the registry carries it on the next render.
 */

type VaultFixture = { current: { items: VaultItem[]; folders: Folder[] } };

const vault = vi.hoisted(
  (): VaultFixture => ({ current: { items: [], folders: [] } }),
);
type InstalledIds = { current: string[] };
const installed = vi.hoisted((): InstalledIds => ({ current: [] }));

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => ({
    installItemTypeDefinition: async (text: string) => {
      const result = installItemType(text);
      if (result.ok) installed.current.push(result.definition.metadata.id);
      return result;
    },
    uninstallItemTypeDefinition: async (id: string) => uninstallItemType(id),
  }),
  useCopySecret: () => vi.fn().mockResolvedValue("copied"),
});

import { ItemTypesPanel } from "./ItemTypesPanel.js";

const TICKET = JSON.stringify({
  apiVersion: "opensesame.dev/v1alpha1",
  kind: "VaultItemType",
  metadata: {
    id: "event-ticket",
    version: "1.0.0",
    publisher: "https://community.test",
  },
  spec: {
    title: "Event ticket",
    plural: "Event tickets",
    extension: ".ticket",
    summary: "A booking reference and the seat it holds.",
    categories: ["documents"],
    sections: [
      {
        id: "booking",
        title: "Booking",
        fields: [
          { id: "event", type: "string", label: "Event", required: true },
          { id: "seat", type: "string", label: "Seat" },
          { id: "reference", type: "concealed", label: "Booking reference" },
        ],
      },
    ],
    native: {
      secret: "reference",
      trailer: [
        { key: "event", field: "event" },
        { key: "seat", field: "seat" },
      ],
    },
    cxf: { credential: "custom-fields" },
    subtitle: ["event", "seat"],
    search: ["event"],
  },
});

beforeEach(() => {
  vault.current = { items: [], folders: [] };
  installed.current = [];
  syncInstalledTypes({});
});

afterEach(() => {
  cleanup();
  syncInstalledTypes({});
});

afterAll(() => {
  Object.assign(vaultHooksSeams, originalVaultHooksSeams);
});

describe("ItemTypesPanel", () => {
  it("lists the built-in types as definitions, not as a separate category", () => {
    render(<ItemTypesPanel />);
    expect(screen.getByText(/^Login/)).toBeTruthy();
    expect(screen.getAllByText(/built in$/).length).toBeGreaterThan(5);
  });

  it("installs a pasted definition and reports it needs no reload", async () => {
    render(<ItemTypesPanel />);
    fireEvent.change(screen.getByLabelText("Add a type"), {
      target: { value: TICKET },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install type" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("no reload"),
    );
    expect(installed.current).toEqual(["event-ticket"]);
    expect(itemTypeRegistry().has("event-ticket")).toBe(true);
  });

  it("says why a definition was refused instead of accepting it", async () => {
    render(<ItemTypesPanel />);
    fireEvent.change(screen.getByLabelText("Add a type"), {
      target: {
        value: TICKET.replace(
          '"subtitle":["event","seat"]',
          '"subtitle":["reference"]',
        ),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install type" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("concealed"),
    );
    expect(itemTypeRegistry().has("event-ticket")).toBe(false);
  });

  it("refuses to remove a built-in type at all", () => {
    render(<ItemTypesPanel />);
    expect(screen.queryByRole("button", { name: "Remove Login" })).toBeNull();
  });

  it("removes an installed type behind a confirmation", async () => {
    installItemType(TICKET);
    render(<ItemTypesPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Event ticket" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Really remove/ }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "keep everything",
      ),
    );
    expect(itemTypeRegistry().has("event-ticket")).toBe(false);
  });
});
