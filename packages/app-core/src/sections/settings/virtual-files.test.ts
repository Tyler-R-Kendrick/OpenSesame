/**
 * Settings as files never offers the device identity key (ADR 0160 §5, ADR
 * 0134): not listed, not read, not checked, not written over, not removed, by
 * any provider and under any spelling of its path.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type VirtualFileProvider,
  isConcealedFilePath,
  mergeFileProviders,
  withoutConcealedFiles,
} from "./virtual-files.js";

const KEY = "config/device-identity-key";

/** A provider that, wrongly, offers and accepts the key like any other file. */
function careless(): VirtualFileProvider & {
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  return {
    list: () => [
      { path: KEY, language: "json", readOnly: false, removable: true },
      {
        path: "settings/x.json",
        language: "json",
        readOnly: false,
        removable: false,
      },
    ],
    read: vi.fn(async () => "PRIVATE KEY MATERIAL"),
    check: () => ({ ok: true }),
    write: vi.fn(async (path: string) => ({ ok: true as const, path })),
    remove: vi.fn(async (path: string) => ({ ok: true as const, path })),
    creates: {
      directory: "settings",
      draftPath: "settings/new.json",
      template: "{}",
    },
  };
}

describe("a concealed path", () => {
  it.each([
    KEY,
    "/config/device-identity-key",
    "config//device-identity-key",
    "./config/device-identity-key",
    "config/./device-identity-key",
    "settings/device-identity-key",
    "CONFIG/Device-Identity-Key",
    "config%2Fdevice-identity-key",
    "config\\device-identity-key",
    "device-identity-key",
  ])("is recognised as %s", (path) => {
    expect(isConcealedFilePath(path)).toBe(true);
  });

  it.each([
    "config/prefs",
    "settings/item-types/marketplaces.json",
    "config/device-identity",
    "settings/device-identity-keys/x.json",
  ])("leaves %s alone", (path) => {
    expect(isConcealedFilePath(path)).toBe(false);
  });
});

describe("a provider behind the guard", () => {
  it("does not list the key and lists everything else", () => {
    const guarded = withoutConcealedFiles(careless());
    expect(guarded.list().map((file) => file.path)).toEqual([
      "settings/x.json",
    ]);
  });

  it("never reads it, and the provider is not even asked", async () => {
    const inner = careless();
    await expect(withoutConcealedFiles(inner).read(KEY)).rejects.toThrow(
      /not shown or changed/,
    );
    expect(inner.read).not.toHaveBeenCalled();
  });

  it("refuses a paste over it, and the provider is not asked to write", async () => {
    const inner = careless();
    const guarded = withoutConcealedFiles(inner);
    expect(guarded.check(KEY, "{}")).toMatchObject({ ok: false });
    await expect(guarded.write(KEY, "{}")).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      guarded.write("config//device-identity-key", "{}"),
    ).resolves.toMatchObject({
      ok: false,
    });
    expect(inner.write).not.toHaveBeenCalled();
  });

  it("refuses to remove it", async () => {
    const inner = careless();
    await expect(
      withoutConcealedFiles(inner).remove(KEY),
    ).resolves.toMatchObject({
      ok: false,
    });
    expect(inner.remove).not.toHaveBeenCalled();
  });

  it("passes every other file through, and keeps what the provider creates", async () => {
    const inner = careless();
    const guarded = withoutConcealedFiles(inner);
    await expect(guarded.write("settings/x.json", "{}")).resolves.toMatchObject(
      {
        ok: true,
      },
    );
    await expect(guarded.read("settings/x.json")).resolves.toBe(
      "PRIVATE KEY MATERIAL",
    );
    expect(guarded.creates?.directory).toBe("settings");
  });

  it("holds over a merge of providers too", async () => {
    const merged = withoutConcealedFiles(
      mergeFileProviders([careless(), careless()]),
    );
    expect(merged.list().some((file) => file.path === KEY)).toBe(false);
    await expect(merged.read(KEY)).rejects.toThrow();
  });
});
