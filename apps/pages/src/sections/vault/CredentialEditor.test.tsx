/** @vitest-environment jsdom */
import { setStatus } from "@opensesame/app-core/lib/type-packs/state.js";
import { resetPackStateForTests } from "@opensesame/app-core/lib/type-packs/state.js";
import {
  type AccountItem,
  type CredentialItem,
  createCredential,
  createItem,
} from "@opensesame/vault-core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  installEditorHarness,
  open,
  saveItem,
  vault,
} from "./account-editor.test-support.js";

function savedCredential(): CredentialItem {
  const item = saveItem.mock.calls[0]?.[0];
  if (item?.kind !== "credential") throw new Error("expected a credential");
  return item;
}

const billing: AccountItem = { ...createItem("account", "Billing") };

describe("the credential types an account may add are the ones this vault has switched on", () => {
  installEditorHarness();

  it("offers every switched-on type and no other", async () => {
    resetPackStateForTests();
    setStatus("password", { phase: "on" });
    setStatus("api-key", { phase: "on" });
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
    ]);
  });

  it("draws no + at all when nothing can be added", () => {
    resetPackStateForTests();
    open("/vault/new/account");
    expect(
      screen.queryByRole("button", { name: "Add login method" }),
    ).toBeNull();
    // The account still opens on its password: Accounts needs Password.
    expect(screen.getByRole("group", { name: "Password method" })).toBeTruthy();
  });

  it("starts a new account on a password whichever types are on", () => {
    resetPackStateForTests();
    setStatus("account", { phase: "on" });
    open("/vault/new/account");
    expect(screen.getByRole("group", { name: "Password method" })).toBeTruthy();
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
