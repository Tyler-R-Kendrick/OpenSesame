/** @vitest-environment jsdom */
import { registerLegacyItemKinds } from "@opensesame/app-core/lib/contributions.test-support.js";
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  enablePepper,
  usePassword,
} from "@opensesame/app-core/lib/vault/generators/index.js";
import { requireLoginDraft } from "@opensesame/app-core/lib/vault/login-draft.js";
import {
  type AccountItem,
  type Folder,
  type PasswordMethod,
  type VaultItem,
  passwordMethod,
} from "@opensesame/vault-core";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  afterAll,
  afterEach,
  beforeAll,
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
const saveItem = vi.hoisted(() => vi.fn<(item: VaultItem) => Promise<void>>());

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => ({ saveItem }),
  useCopySecret: () => vi.fn().mockResolvedValue("copied"),
});
afterAll(() => Object.assign(vaultHooksSeams, originalVaultHooksSeams));

import { ItemEditor } from "./ItemEditor.js";
import { makeAccount } from "./account.test-support.js";

let revokeKinds: () => void = () => undefined;
beforeAll(() => {
  revokeKinds = registerLegacyItemKinds();
});
afterAll(() => revokeKinds());

function open(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/vault/new/:kind?" element={<ItemEditor mode="new" />} />
        <Route
          path="/vault/:itemId/edit"
          element={<ItemEditor mode="edit" />}
        />
        <Route path="*" element={<div>navigated away</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function input(label: string | RegExp): HTMLInputElement {
  const element = screen.getByLabelText(label, { selector: "input" });
  if (!(element instanceof HTMLInputElement))
    throw new Error(`expected an input for ${String(label)}`);
  return element;
}

function block(name: string) {
  return within(screen.getByRole("group", { name: `${name} method` }));
}

function saved(): AccountItem {
  const item = saveItem.mock.calls[0]?.[0];
  if (item?.kind !== "account") throw new Error("expected a saved account");
  return item;
}

function passwordOf(item: AccountItem): PasswordMethod {
  const method = passwordMethod(item);
  if (!method) throw new Error("expected a password method");
  return method;
}

async function typeInPrompt(pepper: string, confirm = false) {
  await userEvent.type(screen.getByLabelText("Pepper"), pepper);
  if (confirm)
    await userEvent.type(screen.getByLabelText("Confirm pepper"), pepper);
}

describe("account editor", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [] };
    saveItem.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("draws the account, not a login, at the legacy route too", () => {
    open("/vault/new/login");
    expect(screen.getByText(".account")).toBeTruthy();
    expect(screen.getByLabelText("Username / ID")).toBeTruthy();
    expect(screen.getByText("Login methods")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Password method" })).toBeTruthy();
  });

  it("starts with one password block and adds each method type from the picker", async () => {
    open("/vault/new/account");
    expect(
      screen.getAllByRole("group", { name: /^Password.* method$/ }),
    ).toHaveLength(1);
    const adds: [string, string, RegExp][] = [
      ["API key", "API key", /^API key$/],
      ["Token", "Token", /^Token$/],
      ["OAuth", "OAuth", /^Client id$/],
      ["Authenticator", "Authenticator", /^Authenticator secret$/],
    ];
    for (const [choice, group, field] of adds) {
      await userEvent.click(
        screen.getByRole("button", { name: "Add login method" }),
      );
      await userEvent.click(screen.getByRole("button", { name: choice }));
      expect(block(group).getByLabelText(field)).toBeTruthy();
      // The new block takes focus on its first field.
      expect(document.activeElement).toBe(block(group).getByLabelText(field));
    }
    await userEvent.click(
      screen.getByRole("button", { name: "Add login method" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Password" }));
    expect(
      screen.getByRole("group", { name: "Password 1 method" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "Password 2 method" }),
    ).toBeTruthy();
  });

  it("closes the picker with Escape and puts focus back on the +", async () => {
    open("/vault/new/account");
    const plus = screen.getByRole("button", { name: "Add login method" });
    await userEvent.click(plus);
    expect(
      screen.getByRole("group", { name: "Login method type" }),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(
      screen.queryByRole("group", { name: "Login method type" }),
    ).toBeNull();
    expect(document.activeElement).toBe(plus);
  });

  it("saves api key, token and oauth fields as typed", async () => {
    open("/vault/new/account");
    for (const choice of ["API key", "Token", "OAuth"]) {
      await userEvent.click(
        screen.getByRole("button", { name: "Add login method" }),
      );
      await userEvent.click(screen.getByRole("button", { name: choice }));
    }
    await userEvent.type(block("API key").getByLabelText("API key"), "ak_1");
    await userEvent.type(block("Token").getByLabelText("Token"), "tok_1");
    await userEvent.type(block("OAuth").getByLabelText("Client id"), "cid");
    await userEvent.type(
      block("OAuth").getByLabelText("Token URL"),
      "https://x.test/t",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(saved().methods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "api-key",
          key: "ak_1",
          header: "X-Api-Key",
        }),
        expect.objectContaining({ type: "token", token: "tok_1" }),
        expect.objectContaining({
          type: "oauth",
          clientId: "cid",
          tokenUrl: "https://x.test/t",
        }),
      ]),
    );
  });

  it("publishes the editor to WebMCP as metadata only, whatever the password holds", async () => {
    open("/vault/new/account?uri=https://bank.example.com");
    await userEvent.selectOptions(
      block("Password").getByLabelText("Password generator"),
      "sphinx",
    );
    const port = requireLoginDraft();
    const view = port.read();
    expect(Object.keys(view).sort()).toEqual([
      "favorite",
      "folderId",
      "folderName",
      "folders",
      "name",
      "url",
      "username",
      "websites",
    ]);
    act(() => {
      port.patch({ username: "set-by-agent" });
    });
    expect(input("Username / ID").value).toBe("set-by-agent");
  });

  it("removes a method, even the last one", async () => {
    open("/vault/new/account");
    await userEvent.click(
      screen.getByRole("button", { name: "Remove password" }),
    );
    expect(screen.queryByRole("group", { name: "Password method" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(saved().methods).toEqual([]);
  });

  it("changes the options with the generator", async () => {
    open("/vault/new/account");
    const password = block("Password");
    const select = password.getByLabelText("Password generator");
    expect(password.getByLabelText("Length")).toBeTruthy();
    expect(password.getByLabelText("Minimum digits")).toBeTruthy();
    expect(password.getByLabelText("Minimum symbols")).toBeTruthy();
    expect(password.getByLabelText("Avoid l1IO0")).toBeTruthy();

    await userEvent.selectOptions(select, "passphrase");
    expect(password.getByLabelText("Word count")).toBeTruthy();
    expect(password.getByLabelText("Separator")).toBeTruthy();
    expect(password.queryByLabelText("Length")).toBeNull();
    expect(
      password
        .getByLabelText("Password", { selector: "input" })
        .getAttribute("type"),
    ).toBe("password");

    await userEvent.selectOptions(select, "sphinx");
    expect(password.getByLabelText("Counter")).toBeTruthy();
    expect(password.getByLabelText("Length")).toBeTruthy();
    // Computed on use: no password field, a mark and a rotate key instead.
    expect(
      password.queryByLabelText("Password", { selector: "input" }),
    ).toBeNull();
    expect(password.getByRole("img", { name: /never stored/ })).toBeTruthy();

    await userEvent.selectOptions(select, "manual");
    expect(password.queryByLabelText("Length")).toBeNull();
    expect(password.queryByLabelText("Word count")).toBeNull();
    expect(
      password.getByLabelText("Password", { selector: "input" }),
    ).toBeTruthy();
    expect(
      password.queryByRole("button", { name: "Generate another password" }),
    ).toBeNull();
  });

  it("offers Include pepper for every generator but Sphinx, and no disabled stand-in", async () => {
    open("/vault/new/account");
    const password = block("Password");
    const select = password.getByLabelText("Password generator");
    for (const id of ["rules", "passphrase", "manual"]) {
      await userEvent.selectOptions(select, id);
      expect(password.getByLabelText("Include pepper")).toBeTruthy();
    }
    await userEvent.selectOptions(select, "sphinx");
    expect(password.queryByLabelText("Include pepper")).toBeNull();
    expect(screen.queryByText("Include pepper")).toBeNull();
  });

  it("saves a Sphinx method with a key and no password at all", async () => {
    open("/vault/new/account?uri=https://bank.example.com");
    await userEvent.selectOptions(
      block("Password").getByLabelText("Password generator"),
      "sphinx",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Rotate password" }),
    );
    expect(input("Counter").value).toBe("1");
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const method = passwordOf(saved());
    expect(method).toMatchObject({ secret: "", pepper: true });
    expect(method.sealed).toBeUndefined();
    expect(method.generator).toMatchObject({
      id: "sphinx",
      realm: "bank.example.com",
      counter: 1,
    });
  });

  it("seals a password under a pepper typed twice, and saves no plaintext", async () => {
    open("/vault/new/account");
    const password = block("Password");
    await userEvent.click(
      password.getByRole("button", { name: "Show password" }),
    );
    const plaintext = input("Password").value;
    expect(plaintext.length).toBeGreaterThan(8);

    await userEvent.click(password.getByLabelText("Include pepper"));
    const dialog = screen.getByRole("dialog", { name: "Set pepper" });
    expect(within(dialog).getByLabelText("Confirm pepper")).toBeTruthy();
    await typeInPrompt("peppercorn", true);
    await userEvent.click(screen.getByRole("button", { name: "Set pepper" }));
    await waitFor(() =>
      expect(
        password.getByLabelText<HTMLInputElement>("Include pepper").checked,
      ).toBe(true),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    // Focus came back to the box that asked.
    expect(document.activeElement).toBe(
      password.getByLabelText("Include pepper"),
    );

    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const item = saved();
    const method = passwordOf(item);
    expect(method.pepper).toBe(true);
    expect(method.secret).toBe("");
    expect(method.sealed).toBeDefined();
    const wire = JSON.stringify(item);
    expect(wire).not.toContain(plaintext);
    expect(wire).not.toContain("peppercorn");
    // Only the right pepper opens it, and it opens to what the editor showed.
    expect(await usePassword(item, method, async () => "peppercorn")).toBe(
      plaintext,
    );
  });

  it("asks for the pepper once at Save when a peppered password is new", async () => {
    const account = makeAccount({ id: "itm_1", password: "old-password" });
    const method = passwordMethod(account);
    if (!method) throw new Error("fixture");
    const sealed = await enablePepper(
      account.id,
      method,
      "old-password",
      "right",
    );
    vault.current = {
      items: [{ ...account, methods: [sealed] }],
      folders: [],
    };
    open("/vault/itm_1/edit");
    // Sealed and unknown: nothing to show, nothing to reveal.
    expect(input("Password").value).toBe("");
    expect(screen.queryByRole("button", { name: "Show password" })).toBeNull();

    const fresh = "fresh-typed-password";
    await userEvent.type(input("Password"), fresh);
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await userEvent.type(await screen.findByLabelText("Pepper"), "left");
    await userEvent.type(screen.getByLabelText("Confirm pepper"), "left");
    await userEvent.click(screen.getByRole("button", { name: "Set pepper" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalledTimes(1));
    const item = saved();
    const next = passwordOf(item);
    expect(next.secret).toBe("");
    expect(JSON.stringify(item)).not.toContain(fresh);
    expect(await usePassword(item, next, async () => "left")).toBe(fresh);
  }, 20_000);

  it("saves nothing when the pepper prompt at Save is closed, and returns focus to Save", async () => {
    const account = makeAccount({ id: "itm_1" });
    const method = passwordMethod(account);
    if (!method) throw new Error("fixture");
    vault.current = {
      items: [{ ...account, methods: [{ ...method, pepper: true }] }],
      folders: [],
    };
    open("/vault/itm_1/edit");
    await userEvent.type(input("Password"), "typed-new");
    const save = screen.getByRole("button", { name: "Save item" });
    await userEvent.click(save);
    expect(
      await screen.findByRole("dialog", { name: "Set pepper" }),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(saveItem).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(save);
    // Closing the prompt is a decision, not a failure.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a wrong pepper as a mark and a tray notice, never a box", async () => {
    const account = makeAccount({ id: "itm_1", password: "old-password" });
    const method = passwordMethod(account);
    if (!method) throw new Error("fixture");
    const sealed = await enablePepper(
      account.id,
      method,
      "old-password",
      "right",
    );
    vault.current = {
      items: [{ ...account, methods: [sealed] }],
      folders: [],
    };
    const { container } = open("/vault/itm_1/edit");
    const password = block("Password");
    await userEvent.click(password.getByLabelText("Include pepper"));
    await userEvent.type(
      await screen.findByLabelText("Pepper"),
      "wrong{Enter}",
    );
    expect(
      await password.findByRole("img", { name: "Wrong pepper" }),
    ).toBeTruthy();
    expect(listNotices().some((n) => n.id === `pepper:${sealed.id}`)).toBe(
      true,
    );
    expect(container.querySelector(".note")).toBeNull();
    expect(container.querySelector(".conn-flash")).toBeNull();
    // Still peppered: a wrong pepper changed nothing.
    expect(
      password.getByLabelText<HTMLInputElement>("Include pepper").checked,
    ).toBe(true);

    await userEvent.click(password.getByLabelText("Include pepper"));
    await userEvent.type(
      await screen.findByLabelText("Pepper"),
      "right{Enter}",
    );
    await waitFor(() =>
      expect(
        password.getByLabelText<HTMLInputElement>("Include pepper").checked,
      ).toBe(false),
    );
    expect(password.queryByRole("img", { name: "Wrong pepper" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(passwordOf(saved())).toMatchObject({
      pepper: false,
      secret: "old-password",
    });
    expect(passwordOf(saved()).sealed).toBeUndefined();
  }, 20_000);
});
