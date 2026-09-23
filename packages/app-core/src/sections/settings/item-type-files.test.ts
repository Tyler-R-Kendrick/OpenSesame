/** @vitest-environment jsdom */
import {
  installItemType,
  mintVaultKey,
  syncInstalledTypes,
  uninstallItemType,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MARKETPLACES_FILE } from "../../lib/item-type-marketplace/marketplaces-file.js";
import { lockAllTombs, unlockTomb } from "../../lib/vfs.js";
import {
  BUILTIN_DIR,
  MARKETPLACES_PATH,
  NEW_TYPE_PATH,
  installedPath,
  itemTypeFiles,
} from "./item-type-files.js";

function manifest(id: string, version = "1.0.0") {
  return JSON.stringify({
    apiVersion: "opensesame.dev/v1alpha1",
    kind: "VaultItemType",
    metadata: { id, version, publisher: "https://example.org" },
    spec: {
      title: "File test",
      plural: "File tests",
      extension: ".ftest",
      summary: "A type for the file test.",
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
  });
}

let tomb: string | null = null;
const files = () =>
  itemTypeFiles({
    tomb: () => tomb,
    install: async (text) => {
      const result = installItemType(text);
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    },
    uninstall: async (id) => uninstallItemType(id),
  });

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  syncInstalledTypes({});
  tomb = null;
});

afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
});

describe("item types as files", () => {
  it("lists the marketplaces file, what is installed, and the built-ins read-only", () => {
    installItemType(manifest("ftest"));
    const listed = files().list();
    expect(listed[0]).toMatchObject({
      path: MARKETPLACES_PATH,
      readOnly: false,
    });
    expect(listed).toContainEqual(
      expect.objectContaining({
        path: installedPath("ftest"),
        removable: true,
      }),
    );
    const wifi = listed.find(
      (file) => file.path === `${BUILTIN_DIR}/wifi.json`,
    );
    expect(wifi).toMatchObject({ readOnly: true, removable: false });
  });

  it("reads each file as the text that is stored", async () => {
    const text = manifest("ftest");
    installItemType(text);
    expect(await files().read(installedPath("ftest"))).toBe(text);
    expect(await files().read(MARKETPLACES_PATH)).toBe(
      DEFAULT_MARKETPLACES_FILE,
    );
    expect(await files().read(`${BUILTIN_DIR}/wifi.json`)).toContain(
      '"id": "wifi"',
    );
  });

  it("installs a new file under the name its id gives it", async () => {
    const outcome = await files().write(NEW_TYPE_PATH, manifest("ftest"));
    expect(outcome).toEqual({ ok: true, path: installedPath("ftest") });
    expect(
      files()
        .list()
        .map((file) => file.path),
    ).toContain(installedPath("ftest"));
  });

  it("refuses a file whose id no longer matches its name", async () => {
    installItemType(manifest("ftest"));
    const outcome = await files().write(
      installedPath("ftest"),
      manifest("other"),
    );
    expect(outcome.ok).toBe(false);
  });

  it("refuses what the parser refuses, and a built-in id", async () => {
    expect((await files().write(NEW_TYPE_PATH, "{}")).ok).toBe(false);
    const wifi = manifest("wifi").replace(".ftest", ".wifi2");
    expect((await files().write(NEW_TYPE_PATH, wifi)).ok).toBe(false);
  });

  it("never writes a built-in, and removing an installed file uninstalls it", async () => {
    expect((await files().write(`${BUILTIN_DIR}/wifi.json`, "{}")).ok).toBe(
      false,
    );
    installItemType(manifest("ftest"));
    expect((await files().remove(installedPath("ftest"))).ok).toBe(true);
    expect(
      files()
        .list()
        .map((file) => file.path),
    ).not.toContain(installedPath("ftest"));
  });

  it("keeps the marketplaces file only where a vault is open", async () => {
    const outcome = await files().write(
      MARKETPLACES_PATH,
      DEFAULT_MARKETPLACES_FILE,
    );
    expect(outcome.ok).toBe(false);
    expect(files().check(MARKETPLACES_PATH, '{"marketplaces":[1]}').ok).toBe(
      false,
    );
  });

  it("seals the marketplaces file in the open tomb and reads it back", async () => {
    tomb = "itype-files";
    unlockTomb(tomb, (await mintVaultKey()).vaultKey);
    const text = '{\n  "marketplaces": ["github:octo/types"]\n}\n';
    expect(await files().write(MARKETPLACES_PATH, text)).toEqual({
      ok: true,
      path: MARKETPLACES_PATH,
    });
    expect(await files().read(MARKETPLACES_PATH)).toBe(text);
  });
});
