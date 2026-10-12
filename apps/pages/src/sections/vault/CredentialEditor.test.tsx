/** @vitest-environment jsdom */
import { setStatus } from "@opensesame/app-core/lib/type-packs/state.js";
import { resetPackStateForTests } from "@opensesame/app-core/lib/type-packs/state.js";
import {
  type AccountItem,
  type CredentialItem,
  createCredential,
  createItem,
} from "@opensesame/vault-core";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  installEditorHarness,
  open,
  saveItem,
  saveItems,
  vault,
} from "./account-editor.test-support.js";
import { credentialPackSeams } from "./account-secrets.js";

const enablePack = vi.spyOn(credentialPackSeams, "enable");

function savedCredential(): CredentialItem {
  const item = saveItem.mock.calls[0]?.[0];
  if (item?.kind !== "credential") throw new Error("expected a credential");
  return item;
}

const billing: AccountItem = { ...createItem("account", "Billing") };

describe("an account can always take a credential", () => {
  installEditorHarness();

  it("draws the + and offers every credential type, whichever are switched on", async () => {
    resetPackStateForTests();
    open("/vault/new/account");
    await userEvent.click(
      screen.getByRole("button", { name: "Add login method" }),
    );
    const picker = within(
      screen.getByRole("group", { name: "Login method type" }),
    );
    expect(picker.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Password",
      "API key",
      "Token",
      "OAuth",
      "Authenticator",
    ]);
    // The account still opens on its password: Accounts needs Password.
    expect(screen.getByRole("group", { name: "Password method" })).toBeTruthy();
  });

  it("adds a method of a type the vault had not switched on, and switches it on", async () => {
    resetPackStateForTests();
    enablePack.mockClear();
    open("/vault/new/account");
    await userEvent.click(
      screen.getByRole("button", { name: "Add login method" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "API key" }));
    expect(screen.getByRole("group", { name: "API key method" })).toBeTruthy();
    expect(enablePack).toHaveBeenCalledWith("api-key");
  });

  it("installs a chosen type for the draft only, remembering nothing", async () => {
    resetPackStateForTests();
    const installer = await import(
      "@opensesame/app-core/lib/type-packs/installer.js"
    );
    const real = vi.spyOn(installer, "enablePack").mockImplementation(() => {});
    credentialPackSeams.enable("api-key");
    expect(real).toHaveBeenCalledWith("api-key", { keep: false });
    real.mockRestore();
  });

  it("gives back the types a draft switched on when the account is abandoned", async () => {
    resetPackStateForTests();
    const release = vi
      .spyOn(credentialPackSeams, "release")
      .mockImplementation(async () => {});
    release.mockClear();
    open("/vault/new/account");
    await userEvent.click(
      screen.getByRole("button", { name: "Add login method" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "API key" }));
    expect(release).not.toHaveBeenCalled();
    cleanup();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]?.[0]).toContain("api-key");
  });

  it("gives back nothing for a type that was already on", async () => {
    resetPackStateForTests();
    setStatus("api-key", { phase: "on" });
    const release = vi
      .spyOn(credentialPackSeams, "release")
      .mockImplementation(async () => {});
    release.mockClear();
    open("/vault/new/account");
    await userEvent.click(
      screen.getByRole("button", { name: "Add login method" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "API key" }));
    cleanup();
    expect(release.mock.calls[0]?.[0] ?? []).not.toContain("api-key");
  });

  it("does not ask for a type that is already on", async () => {
    resetPackStateForTests();
    setStatus("api-key", { phase: "on" });
    enablePack.mockClear();
    open("/vault/new/account");
    await userEvent.click(
      screen.getByRole("button", { name: "Add login method" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "API key" }));
    expect(enablePack).not.toHaveBeenCalled();
  });
});

describe("a credential kept on its own can be bound from the account", () => {
  installEditorHarness();
  const spare = createCredential(
    { id: "k9", type: "api-key", key: "ak_9", header: "X-Api-Key" },
    "Spare key",
    null,
  );

  const elsewhere: AccountItem = { ...createItem("account", "Elsewhere") };

  it("lists the unbound ones, and not those already here, trashed or bound elsewhere", async () => {
    const other = createCredential(
      { id: "k8", type: "api-key", key: "ak_8", header: "X-Api-Key" },
      "On another",
      elsewhere.id,
    );
    const gone = {
      ...createCredential(
        { id: "k7", type: "api-key", key: "ak_7", header: "X-Api-Key" },
        "Trashed",
        null,
      ),
      deletedAt: "2026-01-01T00:00:00.000Z",
    };
    vault.current.items = [billing, elsewhere, spare, other, gone];
    open(`/vault/${billing.id}/edit`);
    await userEvent.click(
      screen.getByRole("button", { name: "Add login method" }),
    );
    const existing = within(
      screen.getByRole("group", { name: "Existing credentials" }),
    );
    expect(existing.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Spare key",
    ]);
  });

  it("binds the chosen one in the same write as the account, never as a copy", async () => {
    vault.current.items = [billing, spare];
    open(`/vault/${billing.id}/edit`);
    await userEvent.click(
      screen.getByRole("button", { name: "Add login method" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Spare key" }));
    expect(screen.getByRole("group", { name: "API key method" })).toBeTruthy();
    await userEvent.click(
      screen.getAllByRole("button", { name: "Save item" })[0],
    );
    await waitFor(() => expect(saveItems).toHaveBeenCalledTimes(1));
    expect(saveItem).not.toHaveBeenCalled();
    const [written] = saveItems.mock.calls[0] ?? [];
    const [account, bound] = written ?? [];
    expect(account?.kind === "account" && account.id).toBe(billing.id);
    expect(
      account?.kind === "account" && account.methods.map((method) => method.id),
    ).not.toContain("k9");
    expect(bound).toMatchObject({
      kind: "credential",
      id: "k9",
      accountId: billing.id,
    });
  });
});

describe("a credential written on its own", () => {
  installEditorHarness();

  it("draws an API key like an account's: header and value, with no ×", async () => {
    open("/vault/new/api-key");
    const group = within(screen.getByRole("group", { name: "API key method" }));
    expect(group.getByLabelText("API header")).toBeTruthy();
    expect(group.getByLabelText("X-Api-Key value")).toBeTruthy();
    expect(group.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(screen.getByLabelText<HTMLSelectElement>("Account").value).toBe("");
  });

  it("saves unbound by default, with the value it was given", async () => {
    open("/vault/new/api-key");
    await userEvent.type(screen.getByLabelText("X-Api-Key value"), "ak_9");
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const credential = savedCredential();
    expect(credential.accountId).toBeNull();
    expect(credential.method).toMatchObject({ type: "api-key", key: "ak_9" });
  });

  it("binds to an account chosen from the live ones", async () => {
    vault.current = {
      items: [billing, { ...createItem("account", "Trashed"), deletedAt: "x" }],
      folders: [],
    };
    open("/vault/new/token");
    const select = screen.getByLabelText("Account");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["None", "Billing"]);
    await userEvent.selectOptions(select, billing.id);
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(savedCredential().accountId).toBe(billing.id);
  });

  it("opens a bound credential on its account and releases it with None", async () => {
    const bound = createCredential(
      { id: "t1", type: "token", token: "tok", expiresAt: "" },
      "Billing · Token",
      billing.id,
    );
    vault.current = { items: [billing, bound], folders: [] };
    open("/vault/t1/edit");
    const select = screen.getByLabelText<HTMLSelectElement>("Account");
    expect(select.value).toBe(billing.id);
    await userEvent.selectOptions(select, "");
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(savedCredential().accountId).toBeNull();
  });

  it("draws no Account row for a new password, and saves it unbound", async () => {
    vault.current = { items: [billing], folders: [] };
    open("/vault/new/password");
    expect(screen.getByRole("group", { name: "Password method" })).toBeTruthy();
    expect(screen.queryByLabelText("Account")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const credential = savedCredential();
    expect(credential.method.type).toBe("password");
    expect(credential.accountId).toBeNull();
  });

  it("draws no Account row for a bound password and leaves its binding alone", async () => {
    const bound = createCredential(
      {
        id: "p2",
        type: "password",
        generator: { id: "manual" },
        pepper: false,
        secret: "hunter2",
        changedAt: "2026-01-01T00:00:00.000Z",
      },
      "Billing · Password",
      billing.id,
    );
    vault.current = { items: [billing, bound], folders: [] };
    open("/vault/p2/edit");
    expect(screen.queryByLabelText("Account")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(savedCredential().accountId).toBe(billing.id);
  });

  it("will not offer another account for a password an earlier pepper sealed", async () => {
    const sealed = createCredential(
      {
        id: "p1",
        type: "password",
        generator: { id: "manual" },
        pepper: true,
        secret: "",
        sealed: {
          v: 2,
          kdf: { alg: "PBKDF2-SHA256", saltB64: "AA==", iterations: 1 },
          seal: { ivB64: "AA==", ctB64: "AA==" },
        },
        changedAt: "2026-01-01T00:00:00.000Z",
      },
      "Old",
      billing.id,
    );
    vault.current = { items: [billing, sealed], folders: [] };
    open("/vault/p1/edit");
    expect(screen.queryByLabelText("Account")).toBeNull();
  });
});
