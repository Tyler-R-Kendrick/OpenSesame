import { describe, expect, it } from "vitest";
import { REGISTERED_ACTIONS } from "./actions.js";
import {
  DEFAULT_KEYBINDINGS,
  importKeybindings,
  resetKeybindings,
} from "./keybindings.js";
import { searchPalette } from "./palette.js";
import { resolveSavedView, viewSharesNoGrant } from "./views.js";

describe("actions and keybindings", () => {
  it("keeps default / as pane search and covers current shortcuts", () => {
    expect(DEFAULT_KEYBINDINGS["/"]).toBe("listing.search");
    expect(DEFAULT_KEYBINDINGS.j).toBe("listing.next");
    expect(DEFAULT_KEYBINDINGS.x).toBe("item.trash");
    expect(
      REGISTERED_ACTIONS.some((action) => action.id === "listing.search"),
    ).toBe(true);
  });

  it("refuses imported bindings that name endpoints or unknown commands", () => {
    const previous = resetKeybindings();
    const url = importKeybindings({ x: "https://evil.example/hook" }, previous);
    expect(url.ok).toBe(false);
    expect(url.bindings).toEqual(previous);
    const unknown = importKeybindings({ x: "not.a.command" }, previous);
    expect(unknown.ok).toBe(false);
    expect(unknown.bindings.x).toBe("item.trash");
  });
});

describe("palette", () => {
  it("finds a setting key and an application name from safe metadata", () => {
    const settings = searchPalette({ query: "autoLock" });
    expect(settings.some((hit) => hit.id === "setting.autoLockMinutes")).toBe(
      true,
    );
    const apps = searchPalette({
      query: "Payroll",
      applications: [
        { id: "a1", name: "Payroll", href: "/identity?view=service-accounts" },
      ],
    });
    expect(apps.some((hit) => hit.id === "app:a1")).toBe(true);
  });

  it("does not search a revoked scope's applications once they are omitted", () => {
    const hits = searchPalette({
      query: "secret-app",
      applications: [],
    });
    expect(hits.some((hit) => hit.label.includes("secret-app"))).toBe(false);
  });
});

describe("saved views", () => {
  it("stores a query, not a grant, and drops unauthorized scopes", () => {
    const view = {
      id: "pending",
      name: "pending approvals",
      collection: "approvals" as const,
      scopeKey: "org:a",
      predicates: { status: "pending" },
    };
    expect(viewSharesNoGrant(view)).toBe(true);
    expect(resolveSavedView(view, "org:a").ok).toBe(true);
    expect(resolveSavedView(view, "org:b").ok).toBe(false);
  });
});
