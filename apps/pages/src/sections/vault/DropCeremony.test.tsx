import { File as NodeFile } from "node:buffer";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DropItem, SecretItem, VaultItem } from "../../lib/vault/model.js";

const store = vi.hoisted(() => ({
  saveItem: vi.fn<(item: VaultItem) => Promise<void>>(),
  purgeItem: vi.fn<(id: string) => Promise<void>>(),
  toggleFavorite: vi.fn<(id: string) => Promise<void>>(),
  trashItem: vi.fn<(id: string) => Promise<void>>(),
  restoreItem: vi.fn<(id: string) => Promise<void>>(),
}));
const createClaim = vi.hoisted(() => vi.fn());
const pollClaim = vi.hoisted(() => vi.fn());

type VaultHarness = {
  current: {
    items: VaultItem[];
    folders: [];
    status: string;
    prefs: {
      autoLockMinutes: number;
      lockOnHide: boolean;
      signOutOnLock: boolean;
      clipboardClearSeconds: number;
      theme: "system";
    };
  };
};

const vault: VaultHarness = {
  current: {
    items: [],
    folders: [],
    status: "locked",
    prefs: {
      autoLockMinutes: 0,
      lockOnHide: false,
      signOutOnLock: false,
      clipboardClearSeconds: 30,
      theme: "system",
    },
  },
};

import { dropSeams } from "../../lib/vault/drop.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
Object.assign(vaultHooksSeams, {
  useVaultStore: () => store,
  useVault: () => vault.current,
});
Object.assign(dropSeams, { createClaim, pollClaim });

import { VaultSection } from "../VaultSection.js";
import {
  DropRecordFields,
  NewDropCeremony,
  ShareSecretDrop,
} from "./DropCeremony.js";

function sessionFor(claimId = "clm_test") {
  return {
    claimId,
    bearerToken: `osc_clm_${claimId}.secret`,
    userCode: "ABCD-EFGH",
    verifyUrl: "https://ceremonies.example/claim",
    expiresAt: "2026-08-30T10:00:00.000Z",
  };
}

function makeSecret(overrides: Partial<SecretItem> = {}): SecretItem {
  return {
    id: "itm_secret",
    kind: "secret",
    name: "Deploy token",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    value: "s3cr3t-value",
    ceiling: [],
    grantees: [],
    connectionRef: "",
    ...overrides,
  };
}

function makeDrop(overrides: Partial<DropItem> = {}): DropItem {
  return {
    id: "itm_drop",
    kind: "drop",
    name: "Deploy token",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    state: "pending",
    claimId: "clm_test",
    bearerToken: "osc_clm_clm_test.secret",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ...overrides,
  };
}

function savedRecord(): DropItem {
  const call = store.saveItem.mock.calls.at(-1);
  if (!call) throw new Error("saveItem was not called");
  const item: VaultItem = call[0];
  if (item.kind !== "drop") throw new Error("saved item is not a drop");
  return item;
}

beforeEach(() => {
  for (const mock of Object.values(store)) mock.mockReset();
  store.saveItem.mockResolvedValue(undefined);
  store.purgeItem.mockResolvedValue(undefined);
  createClaim.mockReset();
  createClaim.mockImplementation(async () => sessionFor());
  pollClaim.mockReset();
  pollClaim.mockResolvedValue("pending");
  vault.current = {
    items: [],
    folders: [],
    status: "locked",
    prefs: {
      autoLockMinutes: 0,
      lockOnHide: false,
      signOutOnLock: false,
      clipboardClearSeconds: 30,
      theme: "system",
    },
  };
});

afterEach(() => {
  cleanup();
  // beforeEach resets mock state; the seam objects themselves stay injected
  // for the whole file (vitest isolates modules per test file).
  Object.assign(vaultHooksSeams, {
    useVaultStore: () => store,
    useVault: () => vault.current,
  });
  Object.assign(dropSeams, { createClaim, pollClaim });
});

describe("share ceremony on a secret", () => {
  it("seals with a TTL and shows the drop card with link, code, and QR", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ShareSecretDrop item={makeSecret()} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: /Share once/i }));
    // TTL picker offers the three contract durations.
    const ttl = screen.getByLabelText("Opens for");
    expect(ttl.querySelectorAll("option")).toHaveLength(3);
    // Keep-a-copy defaults ON when sharing an existing vault secret.
    expect(
      screen.getByRole("checkbox", { name: /Keep a copy/ }),
    ).toHaveProperty("checked", true);

    await user.click(screen.getByRole("button", { name: /Seal and share/i }));
    await screen.findByText("Drop ready");

    expect(
      screen.getByText(/#token=osc_clm_clm_test\.secret&key=/),
    ).toBeTruthy();
    // Once in the code row, once as the QR's shortcode caption.
    expect(screen.getAllByText("ABCD-EFGH").length).toBeGreaterThan(0);
    // The plaintext is never shown again after sealing.
    expect(screen.queryByText("s3cr3t-value")).toBeNull();

    const record = savedRecord();
    expect(record.name).toBe("Deploy token");
    expect(record.state).toBe("pending");
    expect(record.claimId).toBe("clm_test");
    expect(record.bearerToken).toBe("osc_clm_clm_test.secret");
    expect(record.expiresAt).toBe("2026-08-30T10:00:00.000Z");
    expect(record.keptCopy).toEqual({ kind: "text", text: "s3cr3t-value" });
    // The vault secret itself is never modified: the only write is the record.
    expect(store.saveItem).toHaveBeenCalledTimes(1);
    expect(record.id).not.toBe("itm_secret");

    // The manifest the claim carries holds neither plaintext nor the key.
    const [manifest] = createClaim.mock.calls[0] ?? [];
    expect(JSON.stringify(manifest)).not.toContain("s3cr3t-value");
    expect(record.id).toBeTruthy();
  });

  it("stores a bare record when keep-a-copy is unchecked", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ShareSecretDrop item={makeSecret()} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: /Share once/i }));
    await user.click(screen.getByRole("checkbox", { name: /Keep a copy/ }));
    await user.click(screen.getByRole("button", { name: /Seal and share/i }));
    await screen.findByText("Drop ready");

    expect(savedRecord().keptCopy).toBeUndefined();
  });
});

describe("+new drop flow", () => {
  it("seals text and never writes the payload into the vault body", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <NewDropCeremony />
      </MemoryRouter>,
    );

    // Keep-a-copy defaults OFF for a burner drop.
    expect(
      screen.getByRole("checkbox", { name: /Keep a copy/ }),
    ).toHaveProperty("checked", false);

    await user.type(screen.getByLabelText("Name"), "Deploy token");
    await user.type(screen.getByLabelText("Text to drop"), "payload text");
    await user.click(
      screen.getByRole("button", { name: /Seal and create drop/i }),
    );
    await screen.findByText("Drop created");

    const record = savedRecord();
    expect(record.keptCopy).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain("payload text");
  });

  it("names itself when the field is left untouched, and the name is never required", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <NewDropCeremony />
      </MemoryRouter>,
    );

    const nameInput: HTMLInputElement = screen.getByLabelText("Name");
    const suggested = nameInput.placeholder;
    expect(suggested).toMatch(/^[a-z]+(-[a-z]+){2,}$/);

    await user.type(screen.getByLabelText("Text to drop"), "payload text");
    await user.click(
      screen.getByRole("button", { name: /Seal and create drop/i }),
    );
    await screen.findByText("Drop created");

    expect(savedRecord().name).toBe(suggested);
  });

  it("keeps a copy only when asked", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <NewDropCeremony />
      </MemoryRouter>,
    );
    await user.type(screen.getByLabelText("Name"), "Deploy token");
    await user.type(screen.getByLabelText("Text to drop"), "payload text");
    await user.click(screen.getByRole("checkbox", { name: /Keep a copy/ }));
    await user.click(
      screen.getByRole("button", { name: /Seal and create drop/i }),
    );
    await screen.findByText("Drop created");

    expect(savedRecord().keptCopy).toEqual({
      kind: "text",
      text: "payload text",
    });
  });

  it("drops a file chunked, defaulting the name to the file name", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <NewDropCeremony />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: "File" }));
    const input: HTMLInputElement = screen.getByLabelText("File to drop");
    fireEvent.change(input, {
      target: {
        // jsdom's File has no arrayBuffer(); Node's does. The component only
        // reads name/type/arrayBuffer, which both implement.
        files: [
          new NodeFile([new Uint8Array([1, 2, 3, 4])], "w2.pdf", {
            type: "application/pdf",
          }),
        ],
      },
    });
    await user.click(
      screen.getByRole("button", { name: /Seal and create drop/i }),
    );
    await screen.findByText("Drop created");

    const record = savedRecord();
    expect(record.name).toBe("w2.pdf");
    const [manifest] = createClaim.mock.calls[0] ?? [];
    expect(manifest.chunks).toHaveLength(1);
    expect(record.keptCopy).toBeUndefined();
  });
});

describe("disposal", () => {
  it("shows state and countdown on the drop record", () => {
    render(
      <MemoryRouter>
        <DropRecordFields item={makeDrop()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Waiting to be opened")).toBeTruthy();
    expect(screen.getByText(/left$/)).toBeTruthy();
  });

  it("purges the record when the poll says the drop was opened", async () => {
    pollClaim.mockResolvedValue("consumed");
    render(
      <MemoryRouter>
        <DropRecordFields item={makeDrop()} />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(store.purgeItem).toHaveBeenCalledWith("itm_drop"),
    );
  });

  it("keeps the record while the poll is pending", async () => {
    pollClaim.mockResolvedValue("pending");
    render(
      <MemoryRouter>
        <DropRecordFields item={makeDrop()} />
      </MemoryRouter>,
    );
    await screen.findByText("Waiting to be opened");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(store.purgeItem).not.toHaveBeenCalled();
  });

  it("sweeps terminal drop records on vault open", async () => {
    vault.current = {
      ...vault.current,
      items: [makeDrop({ state: "consumed" })],
      status: "unlocked",
    };
    render(
      <MemoryRouter initialEntries={["/vault"]}>
        <Routes>
          <Route path="/vault" element={<VaultSection />}>
            <Route index element={<div>welcome pane</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(store.purgeItem).toHaveBeenCalledWith("itm_drop"),
    );
    expect(pollClaim).not.toHaveBeenCalled();
  });
});
