import type { VaultItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  legacySealedAccount,
  pepperedAccount,
  plainAccount,
} from "../account.test-support.js";
import { registerLegacyShellData } from "../contributions.test-support.js";
import {
  type CommandPorts,
  NOT_AVAILABLE_MESSAGE,
  executeCommand,
  matchItem,
} from "./execute.js";
import { liveSearchOf, parseCommand } from "./parse.js";
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

  it("reads slash commands the same way as the sentence forms", () => {
    expect(parseCommand("/vault")).toEqual({
      action: "navigate",
      path: "/vault",
    });
    expect(parseCommand("/settings")).toEqual({
      action: "navigate",
      path: "/settings",
    });
    expect(parseCommand("/passwords")).toEqual({
      action: "navigate",
      path: "/vault",
    });
    expect(parseCommand("/search router")).toEqual({
      action: "search",
      query: "router",
    });
    expect(parseCommand("/? router")).toEqual({
      action: "search",
      query: "router",
    });
    expect(parseCommand("/?router")).not.toEqual({
      action: "search",
      query: "router",
    });
    expect(parseCommand("/open amazon")).toEqual({
      action: "open_item",
      query: "amazon",
    });
    expect(parseCommand("/open settings/security/config.yaml")).toEqual({
      action: "open_path",
      path: "/settings/security?file=config.yaml",
      label: "settings/security/config.yaml",
    });
    expect(parseCommand("/open settings")).toEqual({
      action: "navigate",
      path: "/settings",
    });
    expect(parseCommand("/copy password for GitHub")).toEqual({
      action: "copy_field",
      field: "password",
      query: "GitHub",
    });
    expect(parseCommand("/help")).toEqual({ action: "help" });
    // `/?` alone is still help; it is search only with words after it.
    expect(parseCommand("/?")).toEqual({ action: "help" });
    expect(parseCommand("/settings/security/config.yaml")).toEqual({
      action: "open_path",
      path: "/settings/security?file=config.yaml",
      label: "settings/security/config.yaml",
    });
  });
});

describe("executeCommand copy_field", () => {
  it("copies the password without returning the secret in the message", async () => {
    const login = plainAccount("GitHub", "s3cret-value");
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

  const portsFor = (
    items: readonly VaultItem[],
    copied: string[],
  ): CommandPorts => ({
    navigate: () => undefined,
    copy: async (value) => {
      copied.push(value);
      return "copied";
    },
    items: () => items,
    vaultLocked: () => false,
  });

  it("copies what comes before a pepper's slot and never asks for the pepper", async () => {
    const account = pepperedAccount("GitHub", "abcdefgh", "-2");
    const copied: string[] = [];
    const ports = portsFor([account], copied);
    expect(Object.keys(ports).sort()).toEqual([
      "copy",
      "items",
      "navigate",
      "vaultLocked",
    ]);
    const first = await executeCommand(
      { action: "copy_field", field: "password", query: "git" },
      ports,
    );
    expect(first).toEqual({
      ok: true,
      message:
        "Copied the start of the password for GitHub: add your pepper, then copy the rest",
    });
    const rest = await executeCommand(
      { action: "copy_field", field: "rest", query: "git" },
      ports,
    );
    expect(rest.ok).toBe(true);
    expect(copied).toEqual(["abcdef", "gh"]);
  });

  it("says to add the pepper after the password when it goes last", async () => {
    const account = pepperedAccount("GitHub", "abcdefgh");
    const copied: string[] = [];
    const outcome = await executeCommand(
      { action: "copy_field", field: "password", query: "git" },
      portsFor([account], copied),
    );
    expect(outcome).toEqual({
      ok: true,
      message: "Copied password for GitHub: add your pepper after it",
    });
    expect(copied).toEqual(["abcdefgh"]);
    const rest = await executeCommand(
      { action: "copy_field", field: "rest", query: "git" },
      portsFor([account], copied),
    );
    expect(rest).toEqual({
      ok: false,
      message: "GitHub has no rest to copy.",
    });
  });

  it("sends an account an older version sealed to be converted, copying nothing", async () => {
    const account = await legacySealedAccount("GitHub", "old-secret", "pepper");
    const copied: string[] = [];
    const outcome = await executeCommand(
      { action: "copy_field", field: "password", query: "git" },
      portsFor([account], copied),
    );
    expect(outcome.ok).toBe(false);
    expect(copied).toEqual([]);
  });

  it("copies an account's username, authenticator seed and first site", async () => {
    const account = plainAccount("GitHub", "pw", {
      username: "octo",
      totp: "JBSWY3DPEHPK3PXP",
    });
    account.uris = [{ id: "u1", uri: "https://github.com", match: "domain" }];
    const copied: string[] = [];
    for (const field of ["username", "otp", "url"] as const) {
      await executeCommand(
        { action: "copy_field", field, query: "git" },
        portsFor([account], copied),
      );
    }
    expect(copied).toEqual(["octo", "JBSWY3DPEHPK3PXP", "https://github.com"]);
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

  it("refuses a slash destination no capability registered, and never navigates", async () => {
    const navigated: string[] = [];
    const command = parseCommand("/connections");
    expect(command).toEqual({ action: "navigate", path: "/connections" });
    if (command === null) return;
    const outcome = await executeCommand(command, ports(navigated));
    expect(outcome).toEqual({ ok: false, message: NOT_AVAILABLE_MESSAGE });
    expect(navigated).toEqual([]);
  });

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

describe("liveSearchOf", () => {
  it("reads the words once `/?` or `/search` is followed by a space", () => {
    expect(liveSearchOf("/? bank")).toBe("bank");
    expect(liveSearchOf("/search  bank card")).toBe("bank card");
    expect(liveSearchOf("  /? x")).toBe("x");
    expect(liveSearchOf("/? ")).toBe("");
  });

  it("is null for anything else, including a bare `/?` that is help", () => {
    for (const text of [
      "",
      "/?",
      "/search",
      "/?bank",
      "search bank",
      "/open bank",
      "bank",
    ]) {
      expect(liveSearchOf(text)).toBeNull();
    }
  });
});
