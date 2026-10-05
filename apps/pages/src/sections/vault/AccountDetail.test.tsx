/** @vitest-environment jsdom */
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  defaultGenerator,
  enablePepper,
  usePassword,
} from "@opensesame/app-core/lib/vault/generators/index.js";
import {
  type AccountItem,
  type Folder,
  type VaultItem,
  passwordMethod,
} from "@opensesame/vault-core";
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

const PLAIN = "correct-horse-battery";

/** An account whose first password is sealed under `right` (one real PBKDF2). */
async function pepperedAccount() {
  const base = makeAccount({ id: "itm_pep", password: PLAIN });
  const method = passwordMethod(base);
  if (!method) throw new Error("fixture");
  const sealed = await enablePepper(base.id, method, PLAIN, "right");
  return { account: { ...base, methods: [sealed] }, method: sealed };
}

function sphinxAccount(): AccountItem {
  const base = makeAccount({ id: "itm_sph", username: "ada" });
  return {
    ...base,
    methods: [
      {
        id: `${base.id}:password`,
        type: "password",
        generator: defaultGenerator("sphinx", { realm: "bank.example.com" }),
        pepper: true,
        secret: "",
        changedAt: base.createdAt,
      },
    ],
  };
}

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

async function answer(pepper: string, label = "Pepper") {
  await userEvent.type(await screen.findByLabelText(label), `${pepper}{Enter}`);
}

describe("account detail", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [] };
    copySecret.mockResolvedValue("copied");
    store.saveItem.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("gives every method its own rows", () => {
    const base = makeAccount({ id: "itm_many", totp: "JBSWY3DPEHPK3PXP" });
    vault.current = {
      items: [
        {
          ...base,
          methods: [
            ...base.methods,
            { id: "k", type: "api-key", key: "ak_secret", header: "X-Api-Key" },
            { id: "t", type: "token", token: "tok_secret", expiresAt: "" },
            {
              id: "o",
              type: "oauth",
              clientId: "cid",
              clientSecret: "csecret",
              tokenUrl: "https://x.test/t",
              scopes: "read",
              refreshToken: "rtok",
            },
          ],
        },
      ],
      folders: [],
    };
    renderAt("itm_many");
    expect(screen.getByText("Username / ID")).toBeTruthy();
    expect(screen.getByText("Authenticator code")).toBeTruthy();
    expect(screen.getByText("API key")).toBeTruthy();
    expect(screen.getByText("Token")).toBeTruthy();
    expect(screen.getByText("Client id")).toBeTruthy();
    // Concealed until asked, never drawn.
    for (const hidden of ["ak_secret", "tok_secret", "csecret", "rtok"])
      expect(screen.queryByText(hidden)).toBeNull();
    expect(screen.getByRole("button", { name: "Reveal api key" })).toBeTruthy();
  });

  it("asks for the pepper to reveal, shows the password, and clears it on hide", async () => {
    const { account } = await pepperedAccount();
    vault.current = { items: [account], folders: [] };
    renderAt("itm_pep");
    expect(screen.queryByText(PLAIN)).toBeNull();
    expect(
      screen.getByRole("img", { name: "Sealed under a pepper" }),
    ).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Reveal password" }),
    );
    expect(screen.getByRole("dialog", { name: "Use pepper" })).toBeTruthy();
    await answer("right");
    expect(await screen.findByText(PLAIN)).toBeTruthy();
    // Nothing of it remains once the sheet is gone but the revealed value.
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Hide password" }),
    );
    expect(screen.queryByText(PLAIN)).toBeNull();
    expect(document.body.innerHTML).not.toContain(PLAIN);
  }, 20_000);

  it("copies a peppered password only after asking, and does nothing when asked no", async () => {
    const { account } = await pepperedAccount();
    vault.current = { items: [account], folders: [] };
    renderAt("itm_pep");
    await userEvent.click(
      screen.getByRole("button", { name: "Copy password" }),
    );
    await screen.findByRole("dialog", { name: "Use pepper" });
    await userEvent.keyboard("nope{Escape}{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(copySecret).not.toHaveBeenCalled();
    // Cancelling is not a wrong pepper.
    expect(
      screen.getByRole("img", { name: "Sealed under a pepper" }),
    ).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Copy password" }),
    );
    await answer("right");
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith(PLAIN));
  }, 20_000);

  it("shows a wrong pepper as a mark and a tray notice, not a box", async () => {
    const { account, method } = await pepperedAccount();
    vault.current = { items: [account], folders: [] };
    const { container } = renderAt("itm_pep");
    await userEvent.click(
      screen.getByRole("button", { name: "Reveal password" }),
    );
    await answer("wrong");
    expect(
      await screen.findByRole("img", { name: "Wrong pepper" }),
    ).toBeTruthy();
    expect(
      listNotices().some((entry) => entry.id === `pepper:${method.id}`),
    ).toBe(true);
    expect(screen.queryByText(PLAIN)).toBeNull();
    expect(container.querySelector(".note, .conn-flash")).toBeNull();
    expect(copySecret).not.toHaveBeenCalled();
  });

  it("reveals a Sphinx password from the master input: the same one twice, another for another", async () => {
    const account = sphinxAccount();
    vault.current = { items: [account], folders: [] };
    renderAt("itm_sph");
    expect(
      screen.getByRole("img", { name: "Computed on use, never stored" }),
    ).toBeTruthy();
    // No update key: there is no stored password to replace.
    expect(
      screen.queryByRole("button", { name: "Update password" }),
    ).toBeNull();

    const read = async (master: string): Promise<string> => {
      await userEvent.click(
        screen.getByRole("button", { name: "Reveal password" }),
      );
      expect(screen.getByLabelText("Master input")).toBeTruthy();
      await answer(master, "Master input");
      const shown = await screen.findByText(/^\S{20}$/);
      const text = shown.textContent ?? "";
      await userEvent.click(
        screen.getByRole("button", { name: "Hide password" }),
      );
      return text;
    };
    const first = await read("one master");
    const again = await read("one master");
    const other = await read("another master");
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    // What the page showed is what the generator computes.
    const method = passwordMethod(account);
    if (!method) throw new Error("fixture");
    expect(await usePassword(account, method, async () => "one master")).toBe(
      first,
    );
  });

  it("updates a peppered password through a pepper typed twice and stores no plaintext", async () => {
    const { account } = await pepperedAccount();
    vault.current = { items: [account], folders: [] };
    renderAt("itm_pep");
    await userEvent.click(
      screen.getByRole("button", { name: "Update password" }),
    );
    await userEvent.click(screen.getByRole("button", { name: /^Enter$/ }));
    await userEvent.type(
      screen.getByPlaceholderText("New password"),
      "brand-new-secret",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save new value" }),
    );
    await userEvent.type(await screen.findByLabelText("Pepper"), "second");
    await userEvent.type(screen.getByLabelText("Confirm pepper"), "second");
    await userEvent.click(screen.getByRole("button", { name: "Set pepper" }));
    await waitFor(() => expect(store.saveItem).toHaveBeenCalled());
    const item = store.saveItem.mock.calls[0]?.[0];
    if (item?.kind !== "account") throw new Error("expected an account");
    const next = passwordMethod(item);
    if (!next) throw new Error("expected a password method");
    expect(next).toMatchObject({ pepper: true, secret: "" });
    expect(next.sealed).toBeDefined();
    expect(JSON.stringify(item)).not.toContain("brand-new-secret");
    expect(await usePassword(item, next, async () => "second")).toBe(
      "brand-new-secret",
    );
  }, 20_000);

  it("closing the pepper prompt on update leaves the editor open and saves nothing", async () => {
    const { account } = await pepperedAccount();
    vault.current = { items: [account], folders: [] };
    renderAt("itm_pep");
    await userEvent.click(
      screen.getByRole("button", { name: "Update password" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save new value" }),
    );
    await screen.findByRole("dialog", { name: "Set pepper" });
    await userEvent.keyboard("{Escape}{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(store.saveItem).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save new value" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
