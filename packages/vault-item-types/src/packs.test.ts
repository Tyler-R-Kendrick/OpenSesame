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
  it("are 18 built-ins beyond the embedded core, known without being loaded", () => {
    expect(packEntries()).toHaveLength(18);
    expect(loadedPacks().size).toBe(0);
    expect(builtinRegistry().has("login")).toBe(false);
    expect(builtinRegistry().has("secret")).toBe(true);
  });

  it("load through the same parser, as platform definitions, and tell listeners", async () => {
    let heard = 0;
    const stop = subscribePacks(() => {
      heard += 1;
    });
    const before = packsVersion();
    const definition = await loadPack("login");
    expect(definition.metadata.id).toBe("login");
    expect(isPackLoaded("login")).toBe(true);
    expect(loadedPackText("login")).toBe(await importPackText("login"));
    expect(builtinRegistry().sourceOf("login")).toBe("builtin");
    expect(heard).toBe(1);
    expect(packsVersion()).toBe(before + 1);
    // A second load answers from what is registered.
    expect(await loadPack("login")).toBe(definition);
    expect(heard).toBe(1);
    expect(dropPack("login")).toBe(true);
    expect(dropPack("login")).toBe(false);
    stop();
  });

  it("refuse text that is not the one the build indexed", async () => {
    const text = await importPackText("login");
    await expect(verifyPackText("login", `${text} `)).rejects.toMatchObject({
      reason: "digest",
    });
    await expect(verifyPackText("nope", text)).rejects.toBeInstanceOf(
      PackError,
    );
  });

  it("refuse a fetch that fails, and register nothing", async () => {
    await expect(
      loadPack("login", () =>
        Promise.reject(new PackError("fetch", "Offline.")),
      ),
    ).rejects.toMatchObject({ reason: "fetch" });
    expect(isPackLoaded("login")).toBe(false);
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
