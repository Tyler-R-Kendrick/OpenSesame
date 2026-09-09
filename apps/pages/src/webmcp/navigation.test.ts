import { afterEach, describe, expect, it, vi } from "vitest";
import {
  navigationPaths,
  navigationTool,
  webmcpNavigationSeam,
} from "./navigation.js";

const original = webmcpNavigationSeam.navigate;
afterEach(() => {
  webmcpNavigationSeam.navigate = original;
});

describe("WebMCP navigation", () => {
  it("opens validated public prefills without allowing secrets or automatic submission", () => {
    const navigate = vi.fn();
    webmcpNavigationSeam.navigate = navigate;
    navigationTool.execute({
      section: "/vault/new",
      itemType: "login",
      prefill: {
        name: "Example",
        username: "public_alias",
        uri: "https://example.com",
      },
    });
    expect(navigate).toHaveBeenCalledWith(
      "/vault/new/login?name=Example&username=public_alias&uri=https%3A%2F%2Fexample.com",
    );
    for (const prefill of [
      { password: "sentinel" },
      { submit: "true" },
      { uri: "https://example.com?token=sentinel" },
      { name: 5 },
    ]) {
      expect(() =>
        navigationTool.execute({ section: "/vault/new", prefill }),
      ).toThrow("invalid_prefill");
    }
    expect(() =>
      navigationTool.execute({ section: "/settings", prefill: { name: "no" } }),
    ).toThrow("invalid_prefill");
    expect(navigate).toHaveBeenCalledOnce();
  });
  it("opens every authored destination, including real section tabs", async () => {
    const navigate = vi.fn();
    webmcpNavigationSeam.navigate = navigate;
    for (const section of navigationPaths()) {
      await navigationTool.execute({ section });
      expect(navigate).toHaveBeenLastCalledWith(section);
    }
    expect(navigationPaths()).toContain("/access?view=requests");
    expect(navigationPaths()).toContain("/identity?view=devices");
    expect(navigationPaths()).toContain("/settings/security");
  });

  it.each([
    "https://attacker.invalid",
    "//attacker.invalid",
    "/vault/../settings",
    "/vault?token=abc",
    "/settings/nope",
  ])("refuses unrecognized destination %s", (section) => {
    expect(() => navigationTool.execute({ section })).toThrow(
      "unknown_section",
    );
  });

  it("locks the ceremony to an installed type and refuses invalid types", async () => {
    const navigate = vi.fn();
    webmcpNavigationSeam.navigate = navigate;
    await navigationTool.execute({ section: "/vault/new", itemType: "login" });
    expect(navigate).toHaveBeenCalledWith("/vault/new/login");
    expect(() =>
      navigationTool.execute({
        section: "/vault/new",
        itemType: "not-installed",
      }),
    ).toThrow("invalid_item_type_destination");
    expect(() =>
      navigationTool.execute({ section: "/settings", itemType: "login" }),
    ).toThrow("invalid_item_type_destination");
  });

  it("refuses unknown item routes and edit without an item", () => {
    expect(() =>
      navigationTool.execute({
        section: "/vault",
        itemId: "missing",
        edit: true,
      }),
    ).toThrow("invalid_item_destination");
    expect(() =>
      navigationTool.execute({ section: "/vault", edit: true }),
    ).toThrow("edit_requires_item");
  });
});
