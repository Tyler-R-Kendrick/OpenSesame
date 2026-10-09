/** @vitest-environment jsdom */
import { registerLegacyItemKinds } from "@opensesame/app-core/lib/contributions.test-support.js";
import { switchCredentialPacksOn } from "@opensesame/app-core/lib/type-packs/credential-packs.test-support.js";
import { FIELD_LIMITS } from "@opensesame/app-core/lib/vault/field-limits.js";
import { createItem } from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectInTray } from "../../components/tray.test-support.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { ItemEditor } from "./ItemEditor.js";

const original = { ...vaultHooksSeams };
const saveItem = vi.fn();
let revokeKinds: () => void;
let revokePacks: () => void;

beforeEach(() => {
  revokeKinds = registerLegacyItemKinds();
  revokePacks = switchCredentialPacksOn();
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ items: [], folders: [] }),
    useVaultStore: () => ({ saveItem }),
  });
});
afterEach(() => {
  revokeKinds();
  revokePacks();
  cleanup();
  Object.assign(vaultHooksSeams, original);
  vi.clearAllMocks();
});

function open(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/vault/new/:kind?" element={<ItemEditor mode="new" />} />
        <Route
          path="/vault/:itemId/edit"
          element={<ItemEditor mode="edit" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

const field = (label: string | RegExp) =>
  screen.getByLabelText<HTMLInputElement>(label);

describe("the most an item's fields hold", () => {
  it("caps free-form fields at the shared limits", async () => {
    open("/vault/new/account?uri=https://example.com");
    expect(field("Username / ID").maxLength).toBe(FIELD_LIMITS.line);
    expect(field("Address 1").maxLength).toBe(FIELD_LIMITS.uri);
    await userEvent.click(screen.getByRole("button", { name: "Add notes" }));
    expect(field("Notes").maxLength).toBe(FIELD_LIMITS.text);
    await userEvent.click(
      screen.getByRole("button", { name: "Add custom field" }),
    );
    expect(field("Field name").maxLength).toBe(FIELD_LIMITS.label);
    expect(field("Field value").maxLength).toBe(FIELD_LIMITS.text);
  });

  it("holds a card number to what a card scheme issues", async () => {
    open("/vault/new/card");
    await userEvent.type(field(/^Number$/i), "1".repeat(30));
    expect(field(/^Number$/i).value).toHaveLength(FIELD_LIMITS.cardNumber);
  });

  it("stops a name growing past the limit as it is typed or pasted", async () => {
    open("/vault/new/note");
    await userEvent.clear(field("Name"));
    await userEvent.click(field("Name"));
    await userEvent.paste("n".repeat(FIELD_LIMITS.name + 40));
    expect(field("Name").value).toHaveLength(FIELD_LIMITS.name);
  });

  it("will not write back a stored name past the limit, and says which", async () => {
    const long = {
      ...createItem("note", "n".repeat(FIELD_LIMITS.name + 10)),
      id: "itm_long",
    };
    Object.assign(vaultHooksSeams, {
      useVault: () => ({ items: [long], folders: [] }),
    });
    open(`/vault/${long.id}/edit`);
    await userEvent.click(field("Name"));
    await userEvent.tab();
    await expectInTray(`at most ${FIELD_LIMITS.name} characters`);
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    expect(saveItem).not.toHaveBeenCalled();
  });

  it("lets a name already over the limit be shortened one key at a time", async () => {
    const long = {
      ...createItem("note", "n".repeat(FIELD_LIMITS.name + 10)),
      id: "itm_long",
    };
    Object.assign(vaultHooksSeams, {
      useVault: () => ({ items: [long], folders: [] }),
    });
    open(`/vault/${long.id}/edit`);
    await userEvent.type(field("Name"), "{Backspace}");
    // Taken as made: nothing past the cursor is cut away on its behalf.
    expect(field("Name").value).toHaveLength(FIELD_LIMITS.name + 9);
    await userEvent.type(field("Name"), "x");
    expect(field("Name").value).toHaveLength(FIELD_LIMITS.name);
  });
});
