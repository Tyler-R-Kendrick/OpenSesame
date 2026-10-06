/** @vitest-environment jsdom */
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  mintOprfKey,
  sphinxPassword,
  vaultEvaluator,
} from "@opensesame/app-core/lib/vault/generators/sphinx.js";
import {
  type AccountItem,
  DEFAULT_RULES,
  type Folder,
  type VaultItem,
  passwordMethod,
  pepperBinding,
  sealWithPepper,
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

import { expectInTray } from "../../components/tray.test-support.js";
import { ItemDetail } from "./ItemDetail.js";
import { makeAccount } from "./account.test-support.js";

const PLAIN = "correct-horse-battery";

/** An account an older version made: its password sealed under the pepper `right`. */
async function sealedAccount() {
  const base = makeAccount({ id: "itm_pep", password: PLAIN });
  const method = passwordMethod(base);
  if (!method) throw new Error("fixture");
  const sealed: typeof method = {
    ...method,
    pepper: true,
    secret: "",
    sealed: await sealWithPepper(
      PLAIN,
      "right",
      pepperBinding(base.id, method.id),
    ),
  };
  return { account: { ...base, methods: [sealed] }, method: sealed };
}

/** A stored password with a slot for the person's own pepper at `at`. */
function slottedAccount(password: string, at?: string): AccountItem {
  const base = makeAccount({ id: "itm_slot", password });
  const method = passwordMethod(base);
  if (!method) throw new Error("fixture");
  return {
    ...base,
    methods: [
      {
        ...method,
        pepper: true,
        ...(at === undefined ? undefined : { pepperAt: at }),
      },
    ],
  };
}

function sphinxAccount(): AccountItem {
  const base = makeAccount({ id: "itm_sph", username: "ada" });
  return {
    ...base,
    methods: [
      {
        id: `${base.id}:password`,
        type: "password",
        generator: {
          id: "sphinx",
          rules: { ...DEFAULT_RULES },
          realm: "bank.example.com",
          counter: 0,
          oprfKeyB64: mintOprfKey(),
        },
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

async function answer(pepper: string, label = "Earlier pepper") {
  await userEvent.type(await screen.findByLabelText(label), `${pepper}{Enter}`);
}

function savedPassword() {
  const item = store.saveItem.mock.calls[0]?.[0];
  if (item?.kind !== "account") throw new Error("expected a saved account");
  const method = passwordMethod(item);
  if (!method) throw new Error("expected a password method");
  return method;
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

  it("generates a replacement password through the update panel", async () => {
    vault.current = {
      items: [makeAccount({ id: "itm_login", password: "hunter2hunter2" })],
      folders: [],
    };
    renderAt("itm_login");
    await userEvent.click(
      screen.getByRole("button", { name: /Update password/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Save new value/i }),
    );
    await waitFor(() => expect(store.saveItem).toHaveBeenCalled());
    const method = savedPassword();
    expect(method.secret).not.toBe("hunter2hunter2");
    expect(method.secret).toHaveLength(32);
    expect(method.changedAt).not.toBe("2026-08-01T00:00:00Z");
  });

  it("requires a value in provide mode and saves what is typed", async () => {
    vault.current = { items: [makeAccount({ id: "itm_login" })], folders: [] };
    renderAt("itm_login");
    await userEvent.click(
      screen.getByRole("button", { name: /Update password/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: /^Enter$/i }));
    await userEvent.click(
      screen.getByRole("button", { name: /Save new value/i }),
    );
    await expectInTray("Enter a new value.");
    expect(store.saveItem).not.toHaveBeenCalled();
    await userEvent.type(
      screen.getByPlaceholderText("New password"),
      "typed-secret-value",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Save new value/i }),
    );
    await waitFor(() => expect(store.saveItem).toHaveBeenCalled());
    expect(savedPassword().secret).toBe("typed-secret-value");
  });

  it("cancels the update panel without saving", async () => {
    vault.current = { items: [makeAccount({ id: "itm_login" })], folders: [] };
    renderAt("itm_login");
    await userEvent.click(
      screen.getByRole("button", { name: /Update password/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(store.saveItem).not.toHaveBeenCalled();
    // Panel collapses back to the trigger button.
    expect(
      screen.getByRole("button", { name: /Update password/i }),
    ).toBeTruthy();
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

  it("marks where the person's pepper goes, copies what comes before it, then the rest, and never asks for one", async () => {
    const account = slottedAccount("abcdefghij", "-4");
    vault.current = { items: [account], folders: [] };
    renderAt("itm_slot");
    expect(
      screen.getByRole("img", { name: "Your pepper goes at -4" }),
    ).toBeTruthy();
    expect(screen.queryByText(/abcdef/)).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Reveal password" }),
    );
    expect(await screen.findByText("abcdef‹pepper›ghij")).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Copy password" }),
    );
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("abcdef"));
    await userEvent.click(
      screen.getByRole("button", { name: "Copy rest of password" }),
    );
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("ghij"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("has no rest to copy when the pepper goes last", async () => {
    vault.current = { items: [slottedAccount("abcdefghij")], folders: [] };
    renderAt("itm_slot");
    expect(
      screen.getByRole("img", { name: "Your pepper goes after it" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Copy rest of password" }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Copy password" }),
    );
    await waitFor(() => expect(copySecret).toHaveBeenCalledWith("abcdefghij"));
  });

  it("updates a password that has a pepper slot as a stored one, keeping the slot, with no prompt", async () => {
    vault.current = { items: [slottedAccount("abcdefghij", "3")], folders: [] };
    renderAt("itm_slot");
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
    await waitFor(() => expect(store.saveItem).toHaveBeenCalled());
    expect(savedPassword()).toMatchObject({
      pepper: true,
      pepperAt: "3",
      secret: "brand-new-secret",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("converts a password an earlier pepper sealed, once, into a stored one", async () => {
    const { account } = await sealedAccount();
    vault.current = { items: [account], folders: [] };
    renderAt("itm_pep");
    expect(
      screen.getByRole("img", {
        name: "Made with an earlier pepper: convert it once",
      }),
    ).toBeTruthy();
    // Nothing to reveal or copy until it is converted.
    expect(screen.queryByRole("button", { name: "Copy password" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Convert password" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Convert password" }),
    ).toBeTruthy();
    await answer("right");
    await waitFor(() => expect(store.saveItem).toHaveBeenCalled());
    const method = savedPassword();
    expect(method).toMatchObject({ pepper: false, secret: PLAIN });
    expect(method.sealed).toBeUndefined();
    expect(method.generator).toEqual({ id: "manual" });
  });

  it("shows a wrong earlier pepper as a mark and a tray notice, never a box, and saves nothing", async () => {
    const { account, method } = await sealedAccount();
    vault.current = { items: [account], folders: [] };
    const { container } = renderAt("itm_pep");
    await userEvent.click(
      screen.getByRole("button", { name: "Convert password" }),
    );
    await answer("wrong");
    expect(
      await screen.findByRole("img", { name: "That did not open it" }),
    ).toBeTruthy();
    expect(
      listNotices().some((entry) => entry.id === `pepper:${method.id}`),
    ).toBe(true);
    expect(container.querySelector(".note, .conn-flash")).toBeNull();
    expect(store.saveItem).not.toHaveBeenCalled();
  });

  it("closing the earlier-pepper prompt converts nothing and says nothing", async () => {
    const { account } = await sealedAccount();
    vault.current = { items: [account], folders: [] };
    renderAt("itm_pep");
    await userEvent.click(
      screen.getByRole("button", { name: "Convert password" }),
    );
    await screen.findByRole("dialog", { name: "Convert password" });
    await userEvent.keyboard("{Escape}{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(store.saveItem).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("converts a Sphinx password from its master input to the password it computed", async () => {
    const account = sphinxAccount();
    vault.current = { items: [account], folders: [] };
    renderAt("itm_sph");
    await userEvent.click(
      screen.getByRole("button", { name: "Convert password" }),
    );
    await answer("one master");
    await waitFor(() => expect(store.saveItem).toHaveBeenCalled());
    const before = passwordMethod(account);
    if (before?.generator.id !== "sphinx") throw new Error("fixture");
    const expected = await sphinxPassword(
      {
        master: "one master",
        realm: before.generator.realm,
        username: account.username,
        counter: before.generator.counter,
        rules: before.generator.rules,
      },
      vaultEvaluator(before.generator.oprfKeyB64),
    );
    expect(savedPassword()).toMatchObject({
      generator: { id: "manual" },
      pepper: false,
      secret: expected,
    });
  });
});
