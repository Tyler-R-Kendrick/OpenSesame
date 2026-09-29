import { describe, expect, it, vi } from "vitest";
import { pluginById } from "../../lib/plugins/catalog.js";
import type { PluginView } from "../../lib/plugins/session.js";
import { pluginFilePath, pluginFiles } from "./plugin-files.js";
import {
  type VirtualFileProvider,
  mergeFileProviders,
} from "./virtual-files.js";

const PLUGIN = pluginById("surrogate-proxy");

function view(overrides: Partial<PluginView> = {}): PluginView {
  return {
    daemon: { label: "desk", host: "desk.tail.ts.net" },
    state: {
      id: "surrogate-proxy",
      installed: true,
      version: "0.1.0",
      enabled: true,
      forcedOff: false,
      active: true,
    },
    notices: [
      {
        event: "surrogate.wrong_host",
        at: "2026-09-28T10:00:00.000Z",
        subject: "run-1",
      },
    ],
    read: true,
    busy: false,
    error: null,
    ...overrides,
  };
}

describe("a plugin as a Settings file (ADR 0134)", () => {
  it("is listed only once the daemon answered, and asks for that read", async () => {
    const ensure = vi.fn();
    let current = view({ read: false, state: null });
    const files = pluginFiles({ plugin: PLUGIN, view: () => current, ensure });
    expect(files.list()).toEqual([]);
    await Promise.resolve();
    expect(ensure).toHaveBeenCalled();
    current = view();
    expect(files.list().map((file) => file.path)).toEqual([
      "settings/capabilities/plugins/surrogate-proxy.json",
    ]);
  });

  it("reads the state the daemon reported, and nothing about how it was reached", async () => {
    const files = pluginFiles({
      plugin: PLUGIN,
      view: () => view(),
      ensure: () => {},
    });
    const text = await files.read(pluginFilePath(PLUGIN));
    expect(JSON.parse(text)).toEqual({
      id: "surrogate-proxy",
      kind: "native-binary",
      capability: "agents.surrogate-credentials",
      installed: true,
      version: "0.1.0",
      enabled: true,
      forced_off: false,
      active: true,
    });
    expect(text).not.toContain("desk");
    expect(text).not.toContain("surrogate.wrong_host");
  });

  it("cannot be written or removed: the switch in its section is the one write", async () => {
    const files = pluginFiles({
      plugin: PLUGIN,
      view: () => view(),
      ensure: () => {},
    });
    const path = pluginFilePath(PLUGIN);
    const [file] = files.list();
    expect(file?.readOnly).toBe(true);
    expect(files.check(path, '{"enabled":false}').ok).toBe(false);
    expect((await files.write(path, '{"enabled":false}')).ok).toBe(false);
    expect((await files.remove(path)).ok).toBe(false);
    await expect(
      files.read("settings/capabilities/plugins/other.json"),
    ).rejects.toThrow();
  });
});

describe("mergeFileProviders", () => {
  function provider(path: string, writes: string[]): VirtualFileProvider {
    return {
      list: () => [
        { path, language: "json", readOnly: false, removable: true },
      ],
      read: async () => path,
      check: () => ({ ok: true }),
      write: async (at) => {
        writes.push(at);
        return { ok: true, path: at };
      },
      remove: async (at) => ({ ok: true, path: at }),
    };
  }

  it("lists every member and routes each path to the member that lists it", async () => {
    const writes: string[] = [];
    const merged = mergeFileProviders([
      provider("a/one.json", writes),
      provider("b/two.json", writes),
    ]);
    expect(merged.list().map((file) => file.path)).toEqual([
      "a/one.json",
      "b/two.json",
    ]);
    expect(await merged.read("b/two.json")).toBe("b/two.json");
    await merged.write("a/one.json", "{}");
    expect(writes).toEqual(["a/one.json"]);
  });

  it("refuses a path no member keeps", async () => {
    const merged = mergeFileProviders([provider("a/one.json", [])]);
    expect(merged.check("x.json", "{}").ok).toBe(false);
    expect((await merged.write("x.json", "{}")).ok).toBe(false);
    await expect(merged.read("x.json")).rejects.toThrow();
  });
});
