import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { lockAllTombs, unlockTomb } from "@opensesame/app-core/lib/vfs.js";
import {
  MARKETPLACES_PATH,
  NEW_TYPE_PATH,
  installedPath,
} from "@opensesame/app-core/sections/settings/item-type-files.js";
import {
  installItemType,
  installedDefinitions,
  mintVaultKey,
  syncInstalledTypes,
  uninstallItemType,
} from "@opensesame/vault-core";
import { useState } from "react";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { SettingsFiles } from "./SettingsFiles.js";

let tombs = 0;
let tomb = "vfiles-0";
const originalHooks = { ...vaultHooksSeams };

function manifest(id: string) {
  return JSON.stringify(
    {
      apiVersion: "opensesame.dev/v1alpha1",
      kind: "VaultItemType",
      metadata: { id, version: "1.0.0", publisher: "https://example.org" },
      spec: {
        title: "Viewer test",
        plural: "Viewer tests",
        extension: ".vtest",
        summary: "A type for the file viewer test.",
        categories: [],
        sections: [
          {
            id: "s",
            title: "S",
            fields: [{ id: "a", type: "string", label: "A" }],
          },
        ],
        native: { secret: "a", trailer: [] },
        cxf: { credential: "custom-fields" },
        subtitle: [],
        search: [],
      },
    },
    null,
    2,
  );
}

function Viewer({ category = "vaults" as const }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <SettingsFiles
      category={category}
      selected={selected}
      onSelect={setSelected}
    />
  );
}

beforeEach(async () => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  tombs += 1;
  tomb = `vfiles-${tombs}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  syncInstalledTypes({});
  Object.assign(vaultHooksSeams, {
    useVault: () => vaultStore.getSnapshot(),
    useVaultStore: () => ({
      activeTomb: () => tomb,
      installItemTypeDefinition: async (text: string) => installItemType(text),
      uninstallItemTypeDefinition: async (id: string) => uninstallItemType(id),
      commitPrefs: async () => undefined,
    }),
  });
});

afterEach(() => {
  cleanup();
  Object.assign(vaultHooksSeams, originalHooks);
  syncInstalledTypes({});
  lockAllTombs();
  vi.unstubAllGlobals();
});

const file = (name: string) => screen.getByRole("button", { name });
const editor = (path: string) =>
  screen.getByRole("textbox", { name: path }) as HTMLTextAreaElement;

describe("Settings' file viewer", () => {
  it("lists the category's document and its files, opening on the document", () => {
    installItemType(manifest("vtest"));
    render(<Viewer />);
    const list = screen.getByRole("navigation", { name: "Files" });
    expect(list.textContent).toContain("config.yaml");
    expect(list.textContent).toContain("marketplaces.json");
    expect(list.textContent).toContain("vtest.json");
    expect(list.textContent).toContain("wifi.json");
    expect(screen.getByLabelText("settings/vaults/config.yaml")).toBeTruthy();
  });

  it("shows a category with no files as its document alone", () => {
    render(<Viewer category={"general" as never} />);
    expect(screen.queryByRole("navigation", { name: "Files" })).toBeNull();
  });

  it("edits marketplaces.json and refuses what it cannot read", async () => {
    render(<Viewer />);
    fireEvent.click(file("marketplaces.json"));
    await waitFor(() =>
      expect(editor(MARKETPLACES_PATH).value).toContain("tyler-r-kendrick"),
    );
    fireEvent.change(editor(MARKETPLACES_PATH), {
      target: { value: '{ "marketplaces": ["http://nope"] }' },
    });
    expect(screen.getByRole("img", { name: /marketplaces\[0\]/ })).toBeTruthy();
    expect(editor(MARKETPLACES_PATH).getAttribute("aria-invalid")).toBe("true");
    const save = screen.getByRole("button", {
      name: `Save ${MARKETPLACES_PATH}`,
    });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(editor(MARKETPLACES_PATH), {
      target: { value: '{ "marketplaces": ["codeberg:octo/types"] }\n' },
    });
    fireEvent.click(save);
    await screen.findByRole("img", { name: `Saved ${MARKETPLACES_PATH}.` });
  });

  it("installs a new file under installed/ and opens it by its id", async () => {
    render(<Viewer />);
    fireEvent.click(file("New file in settings/item-types/installed/"));
    fireEvent.change(editor(NEW_TYPE_PATH), {
      target: { value: manifest("vtest") },
    });
    fireEvent.click(
      screen.getByRole("button", { name: `Save ${NEW_TYPE_PATH}` }),
    );
    await waitFor(() => expect(editor(installedPath("vtest"))).toBeTruthy());
    expect(installedDefinitions().vtest).toBe(manifest("vtest"));
  });

  it("removes an installed file, and shows a built-in read-only", async () => {
    installItemType(manifest("vtest"));
    render(<Viewer />);
    fireEvent.click(file("vtest.json"));
    fireEvent.click(
      screen.getByRole("button", { name: `Remove ${installedPath("vtest")}` }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /; items of this type keep/ }),
    );
    await waitFor(() => expect(installedDefinitions().vtest).toBeUndefined());
    fireEvent.click(screen.getByText("builtin/"));
    fireEvent.click(screen.getByRole("button", { name: /^wifi\.json/ }));
    const builtin = editor("settings/item-types/builtin/wifi.json");
    await waitFor(() => expect(builtin.value).toContain('"id": "wifi"'));
    expect(builtin.readOnly).toBe(true);
    expect(
      screen.getByRole("img", { name: "Part of the build; read-only" }),
    ).toBeTruthy();
  });
});
