import { describe, expect, it } from "vitest";
import type { VaultItem } from "../vault/model.js";
import { createItem } from "../vault/model.js";
import { executeCommand, matchItem } from "./execute.js";
import { parseCommand } from "./parse.js";

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
