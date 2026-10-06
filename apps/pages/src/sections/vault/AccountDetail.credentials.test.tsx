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

  it("draws an API key as two rows like a username and password: its header, then its value", async () => {
    vault.current = { items: [keyed("ak_secret")], folders: [] };
    renderAt("itm_key");
    for (const label of ["API header", "X-Api-Key value", "Token"])
      expect(screen.getByText(label)).toBeTruthy();
    // One row each: no combined line, no second header row.
    expect(screen.queryByText("Header with key")).toBeNull();
    expect(screen.queryByText("Bearer header")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Copy api header" }),
    );
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("X-Api-Key"));
    await userEvent.click(
      screen.getByRole("button", { name: "Copy x-api-key value" }),
    );
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("ak_secret"));
  });

  it("hides the value until asked", async () => {
    vault.current = { items: [keyed("ak_secret")], folders: [] };
    renderAt("itm_key");
    expect(screen.queryByText("ak_secret")).toBeNull();
    // The header is plain; only the value is concealed.
    expect(screen.getByText("X-Api-Key")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Reveal x-api-key value" }),
    );
    expect(await screen.findByText("ak_secret")).toBeTruthy();
  });

  it("copies a token alone", async () => {
    vault.current = { items: [keyed("ak_secret")], folders: [] };
    renderAt("itm_key");
    await userEvent.click(screen.getByRole("button", { name: "Copy token" }));
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("tok_abc"));
  });

  it("holds several API keys, each pair named for its header, numbered where two read alike", () => {
    const base = makeAccount({ id: "itm_key" });
    vault.current = {
      items: [
        {
          ...base,
          methods: [
            { id: "a", type: "api-key", key: "k1", header: "X-Api-Key" },
            { id: "b", type: "api-key", key: "k2", header: "X-Other" },
            { id: "c", type: "api-key", key: "k3", header: "x-api-key" },
          ],
        },
      ],
      folders: [],
    };
    renderAt("itm_key");
    for (const label of [
      "API header 1",
      "API header 2",
      "API header 3",
      "X-Api-Key value 1",
      "X-Other value",
      "x-api-key value 2",
    ])
      expect(screen.getByText(label)).toBeTruthy();
  });

  it("says a value that was never set is not set, and offers nothing to copy for it", async () => {
    vault.current = { items: [keyed("")], folders: [] };
    renderAt("itm_key");
    expect(screen.getByText("Not set")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Copy x-api-key value" }),
    ).toBeNull();
    // The header is still there, and still copies.
    await userEvent.click(
      screen.getByRole("button", { name: "Copy api header" }),
    );
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("X-Api-Key"));
  });

  it("writes a blank or colon-ended header name the usual way", async () => {
    vault.current = { items: [keyed("k1", " X-Token: ")], folders: [] };
    renderAt("itm_key");
    await userEvent.click(
      screen.getByRole("button", { name: "Copy api header" }),
    );
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("X-Token"));
  });
});
