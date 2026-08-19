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

const vault = vi.hoisted(() => ({
  current: {
    items: [] as unknown[],
    folders: [] as { id: string; name: string; createdAt: string }[],
  },
}));
const saveItem = vi.hoisted(() => vi.fn());
const compileSecretToHost = vi.hoisted(() => vi.fn());

vi.mock("../../lib/vault/hooks.js", () => ({
  useVault: () => vault.current,
  useVaultStore: () => ({ saveItem }),
  useCopySecret: () => vi.fn().mockResolvedValue("copied"),
}));

vi.mock("../../lib/connections.js", () => ({
  compileSecretToHost,
}));

import type { LoginItem, SecretItem } from "../../lib/vault/model.js";
import { ItemEditor } from "./ItemEditor.js";

function renderNew(path = "/vault/new/login") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/vault/new/:kind" element={<ItemEditor mode="new" />} />
        <Route
          path="/vault/:itemId/edit"
          element={<ItemEditor mode="edit" />}
        />
        <Route path="*" element={<div>navigated away</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function makeLogin(overrides: Partial<LoginItem> = {}): LoginItem {
  return {
    id: "itm_1",
    kind: "login",
    name: "Webmail",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    username: "me@example.com",
    password: "old-password",
    totp: "",
    uris: [],
    passwordChangedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("ItemEditor", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [] };
    saveItem.mockResolvedValue(undefined);
    compileSecretToHost.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("requires a name before saving", async () => {
    renderNew();
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Give this item a name/)).toBeTruthy();
    expect(saveItem).not.toHaveBeenCalled();
  });

  it("creates a new login and navigates to its detail", async () => {
    renderNew();
    expect(screen.getByRole("heading", { name: /New login/i })).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/^Name$/i), "Webmail");
    await userEvent.type(
      screen.getByLabelText(/^Username$/i),
      "me@example.com",
    );
    await userEvent.type(screen.getByLabelText(/^Password$/i), "s3cret-s3cret");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const saved = saveItem.mock.calls[0]?.[0] as LoginItem;
    expect(saved.kind).toBe("login");
    expect(saved.name).toBe("Webmail");
    expect(saved.username).toBe("me@example.com");
    expect(saved.password).toBe("s3cret-s3cret");
    expect(await screen.findByText("navigated away")).toBeTruthy();
  });

  it("prefills a new login from the save-prompt query", () => {
    renderNew("/vault/new/login?name=Mail&uri=https://mail.example.com");
    expect((screen.getByLabelText(/^Name$/i) as HTMLInputElement).value).toBe(
      "Mail",
    );
    expect(screen.getByDisplayValue("https://mail.example.com")).toBeTruthy();
  });

  it("prefills a new secret connection reference from the query", () => {
    renderNew("/vault/new/secret?name=Token&ref=conn/github/pat");
    expect(
      (screen.getByLabelText(/Connection reference/i) as HTMLInputElement)
        .value,
    ).toBe("conn/github/pat");
  });

  it("prefills a new passkey relying party from the query", () => {
    renderNew("/vault/new/passkey?uri=example.com");
    expect(
      (screen.getByLabelText(/Relying party/i) as HTMLInputElement).value,
    ).toBe("example.com");
  });

  it("falls back to a login when the kind param is unknown", () => {
    renderNew("/vault/new/widget");
    expect(screen.getByRole("heading", { name: /New login/i })).toBeTruthy();
  });

  it("switches item kind and keeps the name", async () => {
    renderNew();
    await userEvent.type(screen.getByLabelText(/^Name$/i), "My card");
    await userEvent.selectOptions(screen.getByLabelText(/^Type$/i), "card");
    expect(screen.getByLabelText(/Cardholder/i)).toBeTruthy();
    expect((screen.getByLabelText(/^Name$/i) as HTMLInputElement).value).toBe(
      "My card",
    );
    expect(screen.getByRole("heading", { name: /New card/i })).toBeTruthy();
  });

  it("strips non-digits from card numbers", async () => {
    renderNew("/vault/new/card");
    await userEvent.type(
      screen.getByLabelText(/^Number$/i),
      "4111-1111 x 4242",
    );
    expect((screen.getByLabelText(/^Number$/i) as HTMLInputElement).value).toBe(
      "411111114242",
    );
  });

  it("adds, edits, and removes website addresses", async () => {
    renderNew();
    await userEvent.click(screen.getByRole("button", { name: /Add address/i }));
    const address = screen.getByLabelText("Address 1");
    await userEvent.type(address, "https://mail.example.com");
    await userEvent.selectOptions(
      screen.getByLabelText("Match rule 1"),
      "exact",
    );
    await userEvent.type(screen.getByLabelText(/^Name$/i), "Mail");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const saved = saveItem.mock.calls[0]?.[0] as LoginItem;
    expect(saved.uris).toHaveLength(1);
    expect(saved.uris[0]).toMatchObject({
      uri: "https://mail.example.com",
      match: "exact",
    });
  });

  it("removes website addresses", async () => {
    renderNew("/vault/new/login?uri=https://mail.example.com");
    expect(screen.getByLabelText("Address 1")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Remove address 1/i }),
    );
    expect(screen.queryByLabelText("Address 1")).toBeNull();
  });

  it("reveals the password field and uses the generator", async () => {
    renderNew();
    const password = screen.getByLabelText(/^Password$/i) as HTMLInputElement;
    expect(password.type).toBe("password");
    await userEvent.click(
      screen.getByRole("button", { name: /Show password/i }),
    );
    expect(password.type).toBe("text");
    await userEvent.click(
      screen.getByRole("button", { name: /Hide password/i }),
    );
    expect(password.type).toBe("password");

    await userEvent.click(
      screen.getByRole("button", { name: /Password generator/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Use this password/i }),
    );
    // Generator applies the value and reveals it.
    expect(password.value.length).toBeGreaterThan(0);
    expect(password.type).toBe("text");
  });

  it("dismisses the generator without applying", async () => {
    renderNew();
    await userEvent.click(
      screen.getByRole("button", { name: /Password generator/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Close generator/i }),
    );
    expect(
      screen.queryByRole("button", { name: /Use this password/i }),
    ).toBeNull();
  });

  it("says there is nothing to edit for a missing item", () => {
    render(
      <MemoryRouter initialEntries={["/vault/itm_gone/edit"]}>
        <Routes>
          <Route
            path="/vault/:itemId/edit"
            element={<ItemEditor mode="edit" />}
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("Nothing to edit")).toBeTruthy();
  });

  it("edits an existing login and bumps passwordChangedAt on password change", async () => {
    vault.current = { items: [makeLogin()], folders: [] };
    render(
      <MemoryRouter initialEntries={["/vault/itm_1/edit"]}>
        <Routes>
          <Route
            path="/vault/:itemId/edit"
            element={<ItemEditor mode="edit" />}
          />
          <Route path="*" element={<div>navigated away</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: /Edit item/i })).toBeTruthy();
    const password = screen.getByLabelText(/^Password$/i);
    await userEvent.clear(password);
    await userEvent.type(password, "brand-new-password");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const saved = saveItem.mock.calls[0]?.[0] as LoginItem;
    expect(saved.password).toBe("brand-new-password");
    expect(saved.passwordChangedAt).not.toBe("2026-08-01T00:00:00Z");
  });

  it("keeps passwordChangedAt when the password is untouched", async () => {
    vault.current = { items: [makeLogin()], folders: [] };
    render(
      <MemoryRouter initialEntries={["/vault/itm_1/edit"]}>
        <Routes>
          <Route
            path="/vault/:itemId/edit"
            element={<ItemEditor mode="edit" />}
          />
          <Route path="*" element={<div>navigated away</div>} />
        </Routes>
      </MemoryRouter>,
    );
    const username = screen.getByLabelText(/^Username$/i);
    await userEvent.clear(username);
    await userEvent.type(username, "other@example.com");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const saved = saveItem.mock.calls[0]?.[0] as LoginItem;
    expect(saved.passwordChangedAt).toBe("2026-08-01T00:00:00Z");
  });

  it("compiles secret grants to the Host after saving", async () => {
    renderNew("/vault/new/secret");
    await userEvent.type(screen.getByLabelText(/^Name$/i), "Deploy hook");
    await userEvent.type(screen.getByLabelText(/Secret value/i), "whsec_1");
    await userEvent.type(
      screen.getByLabelText(/Connection reference/i),
      "conn/github/pat",
    );
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(compileSecretToHost).toHaveBeenCalled());
    expect(await screen.findByText("navigated away")).toBeTruthy();
  });

  it("warns but still saves when the Host grant compile fails", async () => {
    compileSecretToHost.mockRejectedValue(new Error("host down"));
    renderNew("/vault/new/secret");
    await userEvent.type(screen.getByLabelText(/^Name$/i), "Deploy hook");
    await userEvent.type(
      screen.getByLabelText(/Connection reference/i),
      "conn/github/pat",
    );
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    // The save itself succeeds; navigation to the detail still happens.
    await waitFor(() => expect(compileSecretToHost).toHaveBeenCalled());
    expect(await screen.findByText("navigated away")).toBeTruthy();
    expect(saveItem).toHaveBeenCalled();
  });

  it("parses the grantee list from a comma-separated field", async () => {
    renderNew("/vault/new/secret");
    // The controlled input re-joins on every keystroke, so paste-style change
    // is how a comma-separated list actually lands.
    fireEvent.change(
      screen.getByLabelText(/Agents permitted to request a grant/i),
      { target: { value: "agt_one, agt_two,,  " } },
    );
    await userEvent.type(screen.getByLabelText(/^Name$/i), "Token");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const saved = saveItem.mock.calls[0]?.[0] as SecretItem;
    expect(saved.grantees).toEqual(["agt_one", "agt_two"]);
  });

  it("adds, edits, and removes capability ceiling grants", async () => {
    renderNew("/vault/new/secret");
    await userEvent.click(
      screen.getByRole("button", { name: /Add capability/i }),
    );
    await userEvent.type(screen.getByLabelText("Action 1"), "http.post");
    await userEvent.type(
      screen.getByLabelText("Resource 1"),
      "https://deploy.example.com",
    );
    await userEvent.type(screen.getByLabelText(/^Name$/i), "Token");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const saved = saveItem.mock.calls[0]?.[0] as SecretItem;
    expect(saved.ceiling).toHaveLength(1);
    expect(saved.ceiling[0]).toMatchObject({
      action: "http.post",
      resource: "https://deploy.example.com",
    });
  });

  it("removes capability ceiling grants", async () => {
    renderNew("/vault/new/secret");
    await userEvent.click(
      screen.getByRole("button", { name: /Add capability/i }),
    );
    expect(screen.getByLabelText("Action 1")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Remove capability 1/i }),
    );
    expect(screen.queryByLabelText("Action 1")).toBeNull();
  });

  it("manages custom fields with conceal toggles", async () => {
    renderNew();
    await userEvent.click(screen.getByRole("button", { name: /Add field/i }));
    const name = screen.getByLabelText("Field name");
    await userEvent.type(name, "API key");
    const value = screen.getByLabelText("Field value") as HTMLInputElement;
    await userEvent.type(value, "ak_123");
    expect(value.type).toBe("text");
    await userEvent.click(
      screen.getByRole("button", { name: /Conceal this field/i }),
    );
    expect(value.type).toBe("password");
    await userEvent.type(screen.getByLabelText(/^Name$/i), "With fields");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const saved = saveItem.mock.calls[0]?.[0] as LoginItem;
    expect(saved.fields).toEqual([
      expect.objectContaining({
        name: "API key",
        value: "ak_123",
        hidden: true,
      }),
    ]);
  });

  it("removes custom fields", async () => {
    renderNew();
    await userEvent.click(screen.getByRole("button", { name: /Add field/i }));
    await userEvent.type(screen.getByLabelText("Field name"), "API key");
    await userEvent.click(
      screen.getByRole("button", { name: /Remove API key/i }),
    );
    expect(screen.queryByLabelText("Field name")).toBeNull();
  });

  it("assigns a folder and favorite flag", async () => {
    vault.current = {
      items: [],
      folders: [{ id: "fld_1", name: "Work", createdAt: "2026-08-01" }],
    };
    renderNew();
    await userEvent.selectOptions(screen.getByLabelText(/^Folder$/i), "fld_1");
    await userEvent.click(screen.getByLabelText(/Pin to the top of the list/i));
    await userEvent.type(screen.getByLabelText(/^Name$/i), "Filed");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const saved = saveItem.mock.calls[0]?.[0] as LoginItem;
    expect(saved.folderId).toBe("fld_1");
    expect(saved.favorite).toBe(true);
  });

  it("edits passkey and note fields", async () => {
    renderNew("/vault/new/passkey");
    await userEvent.type(
      screen.getByLabelText(/Relying party/i),
      "example.com",
    );
    await userEvent.selectOptions(
      screen.getByLabelText(/^Authenticator$/i),
      "cross-platform",
    );
    await userEvent.type(screen.getByLabelText(/Credential id/i), "Y3JlZA");
    await userEvent.type(screen.getByLabelText(/^Name$/i), "My key");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(saveItem.mock.calls[0]?.[0]).toMatchObject({
      kind: "passkey",
      rpId: "example.com",
      authenticator: "cross-platform",
      credentialIdB64: "Y3JlZA",
    });
  });

  it("surfaces save failures", async () => {
    saveItem.mockRejectedValue(new Error("vault locked"));
    renderNew();
    await userEvent.type(screen.getByLabelText(/^Name$/i), "Nope");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/vault locked/);
  });

  it("uses a generic message for non-Error save failures", async () => {
    saveItem.mockRejectedValue("boom");
    renderNew();
    await userEvent.type(screen.getByLabelText(/^Name$/i), "Nope");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Could not save this item/);
  });

  it("cancels back to the vault list for new items", () => {
    renderNew();
    const cancel = screen.getByRole("link", { name: /Cancel/i });
    expect(cancel.getAttribute("href")).toBe("/vault");
  });
});
