/** @vitest-environment jsdom */
import type { Folder, VaultItem } from "@opensesame/vault-core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

type VaultFixture = { current: { items: VaultItem[]; folders: Folder[] } };

const vault = vi.hoisted(
  (): VaultFixture => ({ current: { items: [], folders: [] } }),
);
const store = vi.hoisted(() => ({
  saveItem: vi.fn<(item: VaultItem) => Promise<void>>(),
}));
const copySecret = vi.hoisted(() => vi.fn());

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => store,
  useCopySecret: () => copySecret,
});
afterAll(() => Object.assign(vaultHooksSeams, originalVaultHooksSeams));

import { ItemDetail } from "./ItemDetail.js";
import { makeAccount } from "./account.test-support.js";

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/vault/${id}`]}>
      <Routes>
        <Route path="/vault/:itemId" element={<ItemDetail />} />
        <Route path="*" element={<div>elsewhere</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("an API key and a token on an account's page", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [] };
    copySecret.mockResolvedValue("copied");
    store.saveItem.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const keyed = (key: string, header = "X-Api-Key") => {
    const base = makeAccount({ id: "itm_key" });
    return {
      ...base,
      methods: [
        { id: "k", type: "api-key" as const, key, header },
        { id: "t", type: "token" as const, token: "tok_abc", expiresAt: "" },
      ],
    };
  };

  it("copies the key, the header name and the whole header line, each from its own row", async () => {
    vault.current = { items: [keyed("ak_secret")], folders: [] };
    renderAt("itm_key");
    for (const label of ["API key", "Header", "Header with key"])
      expect(screen.getByText(label)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Copy api key" }));
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("ak_secret"));
    await userEvent.click(screen.getByRole("button", { name: "Copy header" }));
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("X-Api-Key"));
    await userEvent.click(
      screen.getByRole("button", { name: "Copy header with key" }),
    );
    await waitFor(() =>
      expect(copySecret).toHaveBeenCalledWith("X-Api-Key: ak_secret"),
    );
  });

  it("hides the key everywhere until asked, and reveals the line with its own key", async () => {
    vault.current = { items: [keyed("ak_secret")], folders: [] };
    renderAt("itm_key");
    expect(screen.queryByText(/ak_secret/)).toBeNull();
    // The header's name is shown beside the hidden value of the line.
    expect(screen.getByText("X-Api-Key:")).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Reveal header with key" }),
    );
    expect(await screen.findByText("X-Api-Key: ak_secret")).toBeTruthy();
    expect(screen.queryByText("ak_secret")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Reveal api key" }),
    );
    expect(await screen.findByText("ak_secret")).toBeTruthy();
  });

  it("copies a token alone and as a bearer line", async () => {
    vault.current = { items: [keyed("ak_secret")], folders: [] };
    renderAt("itm_key");
    await userEvent.click(screen.getByRole("button", { name: "Copy token" }));
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("tok_abc"));
    await userEvent.click(
      screen.getByRole("button", { name: "Copy bearer header" }),
    );
    await waitFor(() =>
      expect(copySecret).toHaveBeenCalledWith("Authorization: Bearer tok_abc"),
    );
  });

  it("says a key that was never set is not set, and offers nothing to copy for it", async () => {
    vault.current = { items: [keyed("")], folders: [] };
    renderAt("itm_key");
    expect(screen.getByText("Not set")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy api key" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Copy header with key" }),
    ).toBeNull();
    // The header is still there, and still copies.
    await userEvent.click(screen.getByRole("button", { name: "Copy header" }));
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("X-Api-Key"));
  });

  it("writes a blank or colon-ended header name the usual way", async () => {
    vault.current = { items: [keyed("k1", " X-Token: ")], folders: [] };
    renderAt("itm_key");
    await userEvent.click(
      screen.getByRole("button", { name: "Copy header with key" }),
    );
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("X-Token: k1"));
  });
});
