import { registerLegacyItemKinds } from "@opensesame/app-core/lib/contributions.test-support.js";
import { switchCredentialPacksOn } from "@opensesame/app-core/lib/type-packs/credential-packs.test-support.js";
import { createItem, typeExtension } from "@opensesame/vault-core";
/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectInTray } from "../../components/tray.test-support.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { activateForTest } from "../../modules/runtime-test-kit.js";
import * as drops from "../../modules/sharing.drops/runtime.js";
import { ItemEditor } from "./ItemEditor.js";
import { choose, shown } from "./path-field.test-support.js";

const original = { ...vaultHooksSeams };
const saveItem = vi.fn();
const existing = createItem("note", "Existing note");
const folders = [{ id: "work", name: "Work", createdAt: "2026-01-01" }];

/**
 * Passkey, drop and certificate records are `item-kind` contributions from
 * the capabilities that own them (SURFACE-08), so the type picker and the
 * `?f=` filters only offer them while those capabilities are in the plan.
 * This suite registers the same kinds their runtimes do, and the drop kind's
 * creation form from `sharing.drops` itself.
 */
let revokeItemKinds: () => void;
let revokeDrops: () => void;
let revokePacks: () => void;
beforeEach(async () => {
  revokeItemKinds = registerLegacyItemKinds();
  revokePacks = switchCredentialPacksOn();
  revokeDrops = await activateForTest(drops, ["item-kind"]);
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ items: [existing], folders }),
    useVaultStore: () => ({ saveItem }),
  });
});
afterEach(() => {
  revokeItemKinds();
  revokePacks();
  revokeDrops();
  cleanup();
  Object.assign(vaultHooksSeams, original);
  vi.clearAllMocks();
});

function open(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Link to="/vault/new/account">New account</Link>
      <Link to="/vault/new/card">New card</Link>
      <Link to="/vault/new/drop">New drop</Link>
      <Link to="/vault/new">New any type</Link>
      <Routes>
        <Route path="/vault/new/:kind?" element={<ItemEditor mode="new" />} />
        <Route
          path="/vault/:itemId/edit"
          element={<ItemEditor mode="edit" />}
        />
        {/* Saving lands on the item, as the shell's route does. */}
        <Route path="/vault/:itemId" element={<div>saved</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("vault editor route types", () => {
  it.each(["note", "card", "passkey", "secret", "certificate", "ssh-key"])(
    "%s uses the shared title, natural order and opt-in extras",
    async (kind) => {
      const { container } = open(`/vault/new/${kind}`);
      const name = screen.getByLabelText("Name");
      await userEvent.clear(name);
      await userEvent.type(name, "./Work/Example");
      await userEvent.tab();
      expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
        "Example",
      );
      expect(shown("Folder")).toBe("Work/");
      expect(container.querySelector("[tabindex]")).toBeNull();
      if (kind === "note") expect(screen.getByLabelText("Notes")).toBeTruthy();
      else {
        expect(screen.queryByLabelText("Notes")).toBeNull();
        await userEvent.click(
          screen.getByRole("button", { name: "Add notes" }),
        );
        expect(document.activeElement).toBe(screen.getByLabelText("Notes"));
      }
      expect(screen.queryByLabelText("Field name")).toBeNull();
      await userEvent.click(
        screen.getByRole("button", { name: "Add custom field" }),
      );
      expect(document.activeElement).toBe(screen.getByLabelText("Field name"));
      await userEvent.click(screen.getByRole("button", { name: "Pin item" }));
      expect(
        screen
          .getByRole("button", { name: "Unpin item" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
    },
  );

  it("adds optional account fields on command, focuses them and saves their values", async () => {
    open("/vault/new/login");
    expect(screen.queryByLabelText("Authenticator secret")).toBeNull();
    expect(screen.queryByLabelText("Notes")).toBeNull();
    expect(screen.queryByLabelText("Field name")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Pin item" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    await userEvent.click(
      screen.getByRole("button", { name: "Add login method" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Authenticator" }),
    );
    expect(document.activeElement).toBe(
      screen.getByLabelText("Authenticator secret"),
    );
    await userEvent.type(
      screen.getByLabelText("Authenticator secret"),
      "JBSWY3DPEHPK3PXP",
    );
    await userEvent.click(screen.getByRole("button", { name: "Add notes" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Notes"));
    await userEvent.type(
      screen.getByLabelText("Notes"),
      "Recovery instructions",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Add custom field" }),
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Field name"));
    await userEvent.type(screen.getByLabelText("Field name"), "Account ID");
    await userEvent.type(screen.getByLabelText("Field value"), "example-id");
    await userEvent.type(screen.getByLabelText("Name"), "Login");
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalledOnce());
    expect(saveItem.mock.calls[0][0]).toMatchObject({
      methods: expect.arrayContaining([
        expect.objectContaining({
          type: "authenticator",
          secret: "JBSWY3DPEHPK3PXP",
        }),
      ]),
      notes: "Recovery instructions",
      fields: [
        expect.objectContaining({ name: "Account ID", value: "example-id" }),
      ],
    });
  });

  it("shows existing optional values without a command and keeps cleared fields editable", async () => {
    const login = createItem("account", "Saved account");
    if (login.kind !== "account") throw new Error("Wrong fixture");
    const seed = "JBSWY3DPEHPK3PXP";
    login.methods = [
      ...login.methods,
      { id: `${login.id}:authenticator`, type: "authenticator", secret: seed },
    ];
    login.notes = "Saved notes";
    login.fields = [
      { id: "custom", name: "Account", value: "123", hidden: false },
    ];
    login.favorite = true;
    const useVault = vaultHooksSeams.useVault;
    vaultHooksSeams.useVault = () => ({ ...useVault(), items: [login] });
    open(`/vault/${login.id}/edit`);
    expect(
      screen.getByLabelText<HTMLInputElement>("Authenticator secret").value,
    ).toBe(seed);
    expect(screen.getByLabelText<HTMLTextAreaElement>("Notes").value).toBe(
      login.notes,
    );
    expect(screen.getByLabelText<HTMLInputElement>("Field name").value).toBe(
      "Account",
    );
    expect(screen.queryByRole("button", { name: "Add notes" })).toBeNull();
    await userEvent.clear(screen.getByLabelText("Notes"));
    expect(screen.getByLabelText<HTMLTextAreaElement>("Notes").value).toBe("");
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalledOnce());
    expect(saveItem.mock.calls[0][0]).toMatchObject({
      notes: "",
      methods: login.methods,
      fields: login.fields,
      favorite: true,
    });
  });

  it("resets optional fields between fresh drafts", async () => {
    open("/vault/new/login");
    await userEvent.click(screen.getByRole("button", { name: "Add notes" }));
    await userEvent.click(screen.getByRole("link", { name: "New card" }));
    expect(screen.queryByLabelText("Notes")).toBeNull();
    await userEvent.click(screen.getByRole("link", { name: "New account" }));
    expect(screen.queryByLabelText("Notes")).toBeNull();
    expect(screen.getByRole("button", { name: "Add notes" })).toBeTruthy();
  });
  it("places websites before username and offers explicit pattern modes", async () => {
    open("/vault/new/login");
    await userEvent.click(screen.getByRole("button", { name: "Add address" }));
    const address = screen.getByLabelText("Address 1");
    expect(
      address.compareDocumentPosition(screen.getByLabelText("Username / ID")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await userEvent.selectOptions(
      screen.getByLabelText("Match rule 1"),
      "wildcard",
    );
    expect(screen.getByPlaceholderText("*.example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test match" })).toBeTruthy();
    await userEvent.selectOptions(
      screen.getByLabelText("Match rule 1"),
      "regex",
    );
    expect(screen.getByLabelText("Test website")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Name"), "Example");
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await expectInTray("pattern");
    expect(saveItem).not.toHaveBeenCalled();
  });
  it("moves a typed path into the folder segment as each slash is typed and saves both together", async () => {
    const { container } = open("/vault/new/login?folder=work");
    const row = container.querySelector(".pathfield");
    expect(row?.querySelector("input")?.getAttribute("aria-label")).toBe(
      "Folder",
    );
    expect(shown("Folder")).toBe("Work/");
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "./test/");
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("");
    expect(shown("Folder")).toBe("Work/test/");
    await userEvent.type(screen.getByLabelText("Name"), "login");
    await userEvent.tab();
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("login");
    expect(shown("Folder")).toBe("Work/test/");
    expect(saveItem).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalledTimes(1));
    const [item, folder] = saveItem.mock.calls[0];
    expect(item.name).toBe("login");
    expect(folder.name).toBe("Work/test");
    expect(item.folderId).toBe(folder.id);
    expect(folders).toHaveLength(1);
  });

  it("normalizes on submit without needing a prior blur", async () => {
    const { container } = open("/vault/new/note");
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "/Work/entry");
    const form = container.querySelector("form.editor");
    if (!form) throw new Error("Missing item editor");
    fireEvent.submit(form);
    await waitFor(() => expect(saveItem).toHaveBeenCalledTimes(1));
    expect(saveItem.mock.calls[0][0]).toMatchObject({
      name: "entry",
      folderId: "work",
    });
  });

  it("keeps an invalid path visible and refuses to save it", async () => {
    open("/vault/new/note");
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "../entry");
    await userEvent.tab();
    await expectInTray("vault root");
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
      "../entry",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    expect(saveItem).not.toHaveBeenCalled();
  });

  it("preserves a staged folder when switching through Secret", async () => {
    open("/vault/new");
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "./test/item");
    await userEvent.tab();
    await choose("Type", "secret");
    expect(shown("Folder")).toBe("test/");
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "../Work/entry");
    await userEvent.tab();
    await choose("Type", "note");
    expect(shown("Folder")).toBe("Work/");
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("entry");
  });
  it.each([
    "account",
    "login",
    "card",
    "note",
    "secret",
    "passkey",
    "certificate",
  ])("locks the explicit %s route to its type", (kind) => {
    const { container } = open(`/vault/new/${kind}`);
    expect(screen.queryByRole("combobox", { name: "Type" })).toBeNull();
    expect(container.querySelector(".editor__ext")?.tagName).toBe("SPAN");
    expect(screen.getByLabelText("Name")).toBeTruthy();
  });

  it.each(["widget", "Login", "%20", "login%2Fcard"])(
    "refuses invalid type %s without a saveable draft",
    async (kind) => {
      open(`/vault/new/${kind}`);
      expect(screen.getByText("Unknown item type")).toBeTruthy();
      expect(screen.queryByLabelText("Name")).toBeNull();
      expect(screen.queryByRole("button", { name: "Save item" })).toBeNull();
      await userEvent.click(
        screen.getByRole("link", { name: "Choose an item type" }),
      );
      expect(screen.getByRole("combobox", { name: "Type" })).toBeTruthy();
      expect(saveItem).not.toHaveBeenCalled();
    },
  );

  it("keeps an untyped secret selectable and preserves its name across type changes", async () => {
    open("/vault/new");
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "Draft name");
    await choose("Type", "secret");
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
      "Draft name",
    );
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "Renamed secret");
    await choose("Type", "note");
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
      "Renamed secret",
    );
    expect(shown("Type")).toBe(typeExtension("note"));
  });

  it("resets the draft when navigation supplies a different type", async () => {
    open("/vault/new/account");
    await userEvent.type(screen.getByLabelText("Name"), "Account draft");
    await userEvent.click(screen.getByRole("link", { name: "New card" }));
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.getByLabelText("Cardholder")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toMatch(
      /^Card /,
    );
    expect(screen.queryByLabelText("Type")).toBeNull();
    await userEvent.click(screen.getByRole("link", { name: "New any type" }));
    expect(screen.getByLabelText("Type")).toBeTruthy();
    await userEvent.click(screen.getByRole("link", { name: "New drop" }));
    expect(screen.queryByLabelText("Type")).toBeNull();
    expect(screen.getByText("Drops cannot be edited")).toBeTruthy();
    expect(screen.queryByLabelText("Text to drop")).toBeNull();
  });

  it("does not expose a picker when editing an existing item", () => {
    open(`/vault/${existing.id}/edit`);
    expect(screen.queryByLabelText("Type")).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
      "Existing note",
    );
  });
});
