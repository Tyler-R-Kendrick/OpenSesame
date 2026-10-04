import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectInTray, inTray } from "../../components/tray.test-support.js";

import type { MarketplaceListing } from "@opensesame/app-core/lib/item-type-marketplace/load.js";
import { parseMarketplacesFile } from "@opensesame/app-core/lib/item-type-marketplace/marketplaces-file.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  lockAllTombs,
  unlockTomb,
  writeFile,
} from "@opensesame/app-core/lib/vfs.js";
import {
  MARKETPLACES_PATH,
  installedPath,
} from "@opensesame/app-core/sections/settings/item-type-files.js";
import {
  installItemType,
  installedDefinitions,
  mintVaultKey,
  syncInstalledTypes,
  uninstallItemType,
} from "@opensesame/vault-core";
import { parseDefinition } from "@opensesame/vault-item-types";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { ItemTypesPanel } from "./ItemTypesPanel.js";
import { SettingsFileContext } from "./files/context.js";
import { useItemTypeFiles } from "./files/providers.js";
import {
  forgetMarketplaceListings,
  marketplaceDependencies,
} from "./item-types/useMarketplaces.js";

let tombs = 0;
let TOMB = "itype-panel-0";

function manifest(id: string, title: string, version = "1.0.0") {
  return JSON.stringify({
    apiVersion: "opensesame.dev/v1alpha1",
    kind: "VaultItemType",
    metadata: { id, version, publisher: "https://opensesame.dev" },
    spec: {
      title,
      plural: `${title}s`,
      extension: `.${id.replaceAll("-", "").slice(0, 10)}`,
      summary: `${title} for the panel test.`,
      categories: [],
      sections: [
        {
          id: "s",
          title: "S",
          fields: [
            { id: "name", type: "string", label: "Name" },
            { id: "code", type: "concealed", label: "Booking reference" },
          ],
        },
      ],
      native: { secret: "code", trailer: [{ key: "name", field: "name" }] },
      cxf: { credential: "custom-fields" },
      subtitle: ["name"],
      search: ["name"],
    },
  });
}

function offer(text: string) {
  const parsed = parseDefinition(text, "community");
  if (!parsed.ok) throw new Error("fixture does not parse");
  const definition = parsed.definition;
  // The index refuses a path listed twice, so no two offers share one.
  const path = `item-types/${definition.metadata.id}.json`;
  return { ok: true as const, path, text, sha256: "", definition };
}

const originalHooks = { ...vaultHooksSeams };
const originalLoad = marketplaceDependencies.loadMarketplace;
const install = vi.fn(async (text: string) => installItemType(text));
const uninstall = vi.fn(async (id: string) => uninstallItemType(id));
const store = {
  activeTomb: () => TOMB,
  installItemTypeDefinition: install,
  uninstallItemTypeDefinition: uninstall,
};
const opened = vi.fn();

/** Reads a file through the same provider the panel writes through. */
let readFile: (path: string) => Promise<string> = async () => "";
function FileProbe() {
  const files = useItemTypeFiles();
  readFile = (path) => files.read(path);
  return null;
}

function renderPanel() {
  return render(
    <SettingsFileContext.Provider value={{ openFile: opened }}>
      <FileProbe />
      <ItemTypesPanel />
    </SettingsFileContext.Provider>,
  );
}

beforeEach(async () => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  tombs += 1;
  TOMB = `itype-panel-${tombs}`;
  unlockTomb(TOMB, (await mintVaultKey()).vaultKey);
  syncInstalledTypes({});
  forgetMarketplaceListings();
  Object.assign(vaultHooksSeams, {
    useVault: () => vaultStore.getSnapshot(),
    useVaultStore: () => store,
  });
  marketplaceDependencies.loadMarketplace = vi.fn(
    async (): Promise<MarketplaceListing> => ({
      name: "OpenSesame",
      description: "",
      offers: [
        offer(manifest("vehicle", "Vehicle")),
        offer(manifest("wifi", "Wi-Fi clash")),
        {
          ok: false,
          path: "broken.json",
          problem: "Not found in the repository.",
        },
      ],
    }),
  );
  install.mockClear();
  uninstall.mockClear();
  opened.mockClear();
});

afterEach(() => {
  cleanup();
  Object.assign(vaultHooksSeams, originalHooks);
  marketplaceDependencies.loadMarketplace = originalLoad;
  syncInstalledTypes({});
  lockAllTombs();
  vi.unstubAllGlobals();
});

/** The key that swaps the switches for the marketplaces. */
const openMarketplace = () =>
  fireEvent.click(screen.getByRole("button", { name: "Find more item types" }));

async function marketplaces(): Promise<readonly string[]> {
  const parsed = parseMarketplacesFile(await readFile(MARKETPLACES_PATH));
  return parsed.ok ? parsed.sources : [];
}

describe("ItemTypesPanel", () => {
  it("opens the file a row is drawn from, and a new file from the empty state", () => {
    installItemType(manifest("vehicle", "Vehicle"));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Open vehicle.json" }));
    expect(opened).toHaveBeenCalledWith(installedPath("vehicle"));
    cleanup();
    syncInstalledTypes({});
    renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: "Write a new item type" }),
    );
    expect(opened).toHaveBeenLastCalledWith(
      "settings/item-types/installed/new.json",
    );
  });

  it("reads the listed marketplaces only once the Marketplace tab opens", async () => {
    renderPanel();
    expect(marketplaceDependencies.loadMarketplace).not.toHaveBeenCalled();
    openMarketplace();
    await screen.findByRole("list", { name: "Offered by OpenSesame" });
    expect(marketplaceDependencies.loadMarketplace).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: "Built in" })).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Not found in the repository." }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Install Wi-Fi clash" }),
    ).toBeNull();
  });

  it("installs an offer by writing installed/<id>.json, after its fields are shown", async () => {
    renderPanel();
    openMarketplace();
    fireEvent.click(
      await screen.findByRole("button", { name: "Inspect Vehicle's fields" }),
    );
    const fields = screen.getByRole("list", { name: "Vehicle fields" });
    expect(within(fields).getByText("Booking reference")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install Vehicle" }));
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    await screen.findByRole("img", { name: "Installed, 1.0.0" });
    expect(installedDefinitions().vehicle).toBe(manifest("vehicle", "Vehicle"));
    expect(await readFile(installedPath("vehicle"))).toBe(
      manifest("vehicle", "Vehicle"),
    );
  });

  it("trays a failed install with a mark on the head, never a sentence in the page", async () => {
    install.mockRejectedValueOnce(new Error("Storage is full."));
    renderPanel();
    fireEvent.click(tab("Marketplace"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Install Vehicle" }),
    );
    await expectInTray("Storage is full.");
    expect(screen.getByRole("img", { name: "Storage is full." })).toBeTruthy();
  });

  it("removes by deleting the file, armed in place", async () => {
    installItemType(manifest("vehicle", "Vehicle"));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Remove Vehicle" }));
    expect(uninstall).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: /Remove Vehicle; its items keep/ }),
    );
    await waitFor(() => expect(uninstall).toHaveBeenCalledWith("vehicle"));
  });

  it("adds an external repository as a line in marketplaces.json", async () => {
    renderPanel();
    openMarketplace();
    await screen.findByText("github.com/tyler-r-kendrick/OpenSesame@main");
    const field = screen.getByLabelText("Add a marketplace");
    fireEvent.change(field, { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Add marketplace" }));
    await screen.findByRole("img", { name: /Not a repository this page/ });
    await expectInTray(/Not a repository this page/);
    fireEvent.change(field, {
      target: { value: "https://gitlab.com/team/types" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add marketplace" }));
    await screen.findByText("gitlab.com/team/types");
    expect(await marketplaces()).toEqual([
      "github:tyler-r-kendrick/OpenSesame#main",
      "gitlab:team/types",
    ]);
    fireEvent.click(
      screen.getByRole("button", { name: "Open marketplaces.json" }),
    );
    expect(opened).toHaveBeenCalledWith(MARKETPLACES_PATH);
  });

  it("trays a marketplace that cannot be read, marks its row, and drops the notice with the row", async () => {
    marketplaceDependencies.loadMarketplace = vi.fn(async () => {
      throw new Error("The repository is rate limited.");
    });
    renderPanel();
    fireEvent.click(tab("Marketplace"));
    await expectInTray("The repository is rate limited.");
    expect(
      screen.getByRole("img", { name: "The repository is rate limited." }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Stop reading github.com/tyler-r-kendrick/OpenSesame@main",
      }),
    );
    await screen.findByText("No marketplaces listed.");
    expect(inTray("The repository is rate limited.")).toBe(false);
  });

  it("offers ours back once it has been removed from the file", async () => {
    renderPanel();
    openMarketplace();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Stop reading github.com/tyler-r-kendrick/OpenSesame@main",
      }),
    );
    await screen.findByText("No marketplaces listed.");
    expect(await marketplaces()).toEqual([]);
    fireEvent.click(
      screen.getByRole("button", {
        name: "List the OpenSesame marketplace again",
      }),
    );
    await screen.findByText("github.com/tyler-r-kendrick/OpenSesame@main");
  });

  it("reads the open vault's marketplaces.json, and follows a switch to another", async () => {
    const first = TOMB;
    const second = `${TOMB}-other`;
    unlockTomb(second, (await mintVaultKey()).vaultKey);
    const file = (repo: string) =>
      new TextEncoder().encode(JSON.stringify({ marketplaces: [repo] }));
    await writeFile(
      first,
      "config/item-types/marketplaces.json",
      file("github:octo/first"),
    );
    await writeFile(
      second,
      "config/item-types/marketplaces.json",
      file("github:octo/second"),
    );
    let open = first;
    // One store, as the app has: only the vault it has open changes.
    const switching = { ...store, activeTomb: () => open };
    Object.assign(vaultHooksSeams, {
      useVault: () => ({ ...vaultStore.getSnapshot(), tomb: open }),
      useVaultStore: () => switching,
    });
    const view = renderPanel();
    openMarketplace();
    await screen.findByText("github.com/octo/first");
    open = second;
    view.rerender(
      <SettingsFileContext.Provider value={{ openFile: opened }}>
        <FileProbe />
        <ItemTypesPanel />
      </SettingsFileContext.Provider>,
    );
    await screen.findByText("github.com/octo/second");
    expect(screen.queryByText("github.com/octo/first")).toBeNull();
  });

  it("offers no edit of marketplaces.json before it has been read", () => {
    renderPanel();
    openMarketplace();
    fireEvent.change(screen.getByLabelText("Add a marketplace"), {
      target: { value: "octo/types" },
    });
    const add = screen.getByRole("button", { name: "Add marketplace" });
    expect((add as HTMLButtonElement).disabled).toBe(true);
  });
});
