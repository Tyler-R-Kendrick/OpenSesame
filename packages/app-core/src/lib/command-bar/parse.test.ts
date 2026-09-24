import { type VaultItem, createItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { registerLegacyShellData } from "../contributions.test-support.js";
import {
  type CommandPorts,
  NOT_AVAILABLE_MESSAGE,
  executeCommand,
  matchItem,
} from "./execute.js";
import { parseCommand } from "./parse.js";
import {
  COMMAND_SECTIONS,
  commandSections,
  isCommandSection,
} from "./types.js";

describe("parseCommand", () => {
  it("navigates to known sections", () => {
    expect(parseCommand("go to vault")).toEqual({
      action: "navigate",
      path: "/vault",
    });
    expect(parseCommand("open settings")).toEqual({
      action: "navigate",
      path: "/settings",
    });
  });

  it("opens a setting key from the command palette registry", () => {
    expect(parseCommand("autoLockMinutes")).toEqual({
      action: "open_path",
      path: "/settings",
      label: "autoLockMinutes",
    });
  });

  it("opens a settings directory's config.yaml by its path", () => {
    expect(parseCommand("settings/security/config.yaml")).toEqual({
      action: "open_path",
      path: "/settings/security?file=config.yaml",
      label: "settings/security/config.yaml",
    });
    expect(parseCommand("settings/nowhere/config.yaml")?.action).not.toBe(
      "open_path",
    );
  });

  it("opens prefs aliases and refuses ledger path guesses", () => {
    expect(parseCommand("settings/prefs.yaml")).toEqual({
      action: "open_path",
      path: "/settings",
      label: "settings/prefs.yaml",
    });
    expect(parseCommand(".config/opensesame/prefs.yaml")).toEqual({
      action: "open_path",
      path: "/settings",
      label: ".config/opensesame/prefs.yaml",
    });
    expect(parseCommand("config/identity-grants")).toEqual({
      action: "refuse",
      message: "That path is not an editable document.",
    });
    expect(parseCommand(".config/../config/identity-grants")).toEqual({
      action: "refuse",
      message: "That path is not an editable document.",
    });
    expect(parseCommand("open config/identity-grants")).toEqual({
      action: "refuse",
      message: "That path is not an editable document.",
    });
  });

  it("copies a named field", () => {
    expect(parseCommand("copy password for GitHub")).toEqual({
      action: "copy_field",
      field: "password",
      query: "GitHub",
    });
    expect(parseCommand("copy username of work")).toEqual({
      action: "copy_field",
      field: "username",
      query: "work",
    });
  });

  it("opens and searches", () => {
    expect(parseCommand("open amazon")).toEqual({
      action: "open_item",
      query: "amazon",
    });
    expect(parseCommand("search bank")).toEqual({
      action: "search",
      query: "bank",
    });
  });
});

describe("executeCommand copy_field", () => {
  it("copies the password without returning the secret in the message", async () => {
    const login = createItem("login", "GitHub");
    login.password = "s3cret-value";
    const copied: string[] = [];
    const navigated: string[] = [];
    const outcome = await executeCommand(
      { action: "copy_field", field: "password", query: "git" },
      {
        navigate: (path) => navigated.push(path),
        copy: async (value) => {
          copied.push(value);
          return "copied";
        },
        items: () => {
          const list: readonly VaultItem[] = [login];
          return list;
        },
        vaultLocked: () => false,
      },
    );
    expect(outcome).toEqual({
      ok: true,
      message: "Copied password for GitHub",
    });
    expect(copied).toEqual(["s3cret-value"]);
    expect(matchItem([login], "git")?.name).toBe("GitHub");
    expect(navigated).toEqual([]);
  });

  it("refuses when the vault is locked", async () => {
    const outcome = await executeCommand(
      { action: "copy_field", field: "password", query: "x" },
      {
        navigate: () => undefined,
        copy: async () => "copied",
        items: () => [],
        vaultLocked: () => true,
      },
    );
    expect(outcome.ok).toBe(false);
  });
});

/**
 * SURFACE-09. A command names a destination; the plan decides whether that
 * destination exists. An unregistered path is refused in the command bar
 * itself — nothing reaches for the module that would have served the route.
 */
describe("executeCommand navigate", () => {
  function ports(navigated: string[]): CommandPorts {
    return {
      navigate: (path) => navigated.push(path),
      copy: async () => "copied",
      items: () => [],
      vaultLocked: () => false,
    };
  }

  it("refuses a section no capability registered, and never navigates", async () => {
    const navigated: string[] = [];
    const outcome = await executeCommand(
      { action: "navigate", path: "/connections" },
      ports(navigated),
    );
    expect(outcome).toEqual({ ok: false, message: NOT_AVAILABLE_MESSAGE });
    expect(navigated).toEqual([]);
    expect(isCommandSection("/connections")).toBe(false);
  });

  it("always opens the two core sections", async () => {
    const navigated: string[] = [];
    for (const path of COMMAND_SECTIONS) {
      const outcome = await executeCommand(
        { action: "navigate", path },
        ports(navigated),
      );
      expect(outcome.ok).toBe(true);
    }
    expect(navigated).toEqual(["/vault", "/settings"]);
  });

  it("opens a contributed section while its capability is in the plan", async () => {
    const revoke = registerLegacyShellData();
    const navigated: string[] = [];
    expect(commandSections()).toContain("/connections");
    const outcome = await executeCommand(
      { action: "navigate", path: "/connections" },
      ports(navigated),
    );
    expect(outcome).toEqual({ ok: true, message: "Opened /connections" });
    expect(navigated).toEqual(["/connections"]);
    revoke();

    // Gone with the capability: the same command is refused again.
    expect(
      await executeCommand(
        { action: "navigate", path: "/connections" },
        ports(navigated),
      ),
    ).toEqual({ ok: false, message: NOT_AVAILABLE_MESSAGE });
    expect(navigated).toEqual(["/connections"]);
  });
});
