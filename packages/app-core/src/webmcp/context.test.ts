import { afterEach, describe, expect, it } from "vitest";
import {
  SESSION_TOOL_CONTEXTS,
  getWebMcpEditorKind,
  sessionToolsFor,
  setWebMcpEditorKind,
  subscribeWebMcpEditorKind,
  webmcpContext,
} from "./context.js";
import { WEBMCP_TOOLS } from "./tools.js";

afterEach(() => setWebMcpEditorKind(null));

describe("webmcpContext", () => {
  it("keeps settings, access, connections and identity on their own screens", () => {
    expect(webmcpContext("/settings/security", null)).toBe("settings");
    expect(webmcpContext("/access?view=grants", null)).toBe("access");
    expect(webmcpContext("/connections", null)).toBe("connections");
    expect(webmcpContext("/identity", null)).toBe("identity");
  });

  it("treats a login editor as its own surface, even on /vault/new", () => {
    expect(webmcpContext("/vault/new/login", null)).toBe("login_form");
    expect(webmcpContext("/vault/new", null)).toBe("login_form");
    expect(webmcpContext("/vault/abc/edit", "login")).toBe("login_form");
    expect(webmcpContext("/vault/new", "note")).toBe("vault");
    expect(webmcpContext("/vault", null)).toBe("vault");
    expect(webmcpContext("/vault", "login")).toBe("vault");
    expect(webmcpContext("/vault?f=trash", "login")).toBe("vault");
    expect(webmcpContext("/settings", "login")).toBe("settings");
  });
});

describe("sessionToolsFor", () => {
  it("maps every session tool onto at least one surface", () => {
    const session = WEBMCP_TOOLS.filter((tool) => tool.scope === "session");
    expect(new Set(Object.keys(SESSION_TOOL_CONTEXTS))).toEqual(
      new Set(session.map((tool) => tool.name)),
    );
  });

  it("does not put settings or vault catalog tools on the login form", () => {
    const names = sessionToolsFor(WEBMCP_TOOLS, "login_form").map(
      (tool) => tool.name,
    );
    expect(names).toContain("opensesame_login_draft");
    expect(names).not.toContain("opensesame_settings_read");
    expect(names).not.toContain("opensesame_vault_search");
    expect(names).not.toContain("opensesame_connections_read");
  });
});

describe("editor kind seam", () => {
  it("notifies subscribers when the on-screen editor kind changes", () => {
    let seen = 0;
    const stop = subscribeWebMcpEditorKind(() => {
      seen += 1;
    });
    setWebMcpEditorKind("login");
    expect(getWebMcpEditorKind()).toBe("login");
    setWebMcpEditorKind("login");
    expect(seen).toBe(1);
    stop();
  });
});
