import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinRegistry } from "./builtin.js";
import {
  PackError,
  dropPack,
  importPackText,
  isPackLoaded,
  loadPack,
  loadedPackText,
  loadedPacks,
  packEntries,
  packsVersion,
  subscribePacks,
  verifyPackText,
} from "./packs.js";
import { loadEveryPack } from "./packs.test-support.js";
import { communityDefinition } from "./registry.test-support.js";

beforeEach(() => {
  for (const entry of packEntries()) dropPack(entry.id);
});

afterEach(loadEveryPack);

describe("packs", () => {
  it("are 23 built-ins beyond the embedded core, known without being loaded", () => {
    expect(packEntries()).toHaveLength(23);
    expect(loadedPacks().size).toBe(0);
    expect(builtinRegistry().has("account")).toBe(false);
    expect(builtinRegistry().has("secret")).toBe(true);
  });

  it("load through the same parser, as platform definitions, and tell listeners", async () => {
    let heard = 0;
    const stop = subscribePacks(() => {
      heard += 1;
    });
    const before = packsVersion();
    const definition = await loadPack("account");
    expect(definition.metadata.id).toBe("account");
    expect(isPackLoaded("account")).toBe(true);
    expect(loadedPackText("account")).toBe(await importPackText("account"));
    expect(builtinRegistry().sourceOf("account")).toBe("builtin");
    expect(heard).toBe(1);
    expect(packsVersion()).toBe(before + 1);
    // A second load answers from what is registered.
    expect(await loadPack("account")).toBe(definition);
    expect(heard).toBe(1);
    expect(dropPack("account")).toBe(true);
    expect(dropPack("account")).toBe(false);
    stop();
  });

  it("refuse text that is not the one the build indexed", async () => {
    const text = await importPackText("account");
    await expect(verifyPackText("account", `${text} `)).rejects.toMatchObject({
      reason: "digest",
    });
    await expect(verifyPackText("nope", text)).rejects.toBeInstanceOf(
      PackError,
    );
  });

  it("refuse a fetch that fails, and register nothing", async () => {
    await expect(
      loadPack("account", () =>
        Promise.reject(new PackError("fetch", "Offline.")),
      ),
    ).rejects.toMatchObject({ reason: "fetch" });
    expect(isPackLoaded("account")).toBe(false);
  });

  it("keep their id, title, directory and extension while off", () => {
    const registry = builtinRegistry();
    const clash = (id: string, patch: (text: string) => string) =>
      registry.check(patch(communityDefinition(id, "https://community.test")));
    const taken = registry.check(
      communityDefinition("wifi", "https://community.test"),
    );
    expect(taken).toMatchObject({ ok: false });
    expect(registry.isBuiltin("wifi")).toBe(true);
    const byExtension = clash("my-wifi", (text) =>
      text.replace(/"extension":\s*"[^"]*"/, '"extension": ".wifi"'),
    );
    expect(byExtension).toMatchObject({ ok: false });
    const byTitle = clash("my-wifi", (text) =>
      text.replace(/"title":\s*"[^"]*"/, '"title": "Wi-Fi network"'),
    );
    expect(byTitle).toMatchObject({ ok: false });
  });
});
