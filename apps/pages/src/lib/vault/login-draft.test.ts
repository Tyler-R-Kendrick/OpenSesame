import { describe, expect, it } from "vitest";
import { createItem } from "./model.js";
import {
  applyLoginDraftPatch,
  bindLoginDraft,
  loginDraftView,
  requireLoginDraft,
} from "./login-draft.js";

describe("login draft port", () => {
  it("projects metadata and never includes the password", () => {
    const login = {
      ...createItem("login", "GitHub"),
      username: "ada",
      password: "secret",
      uris: [
        {
          id: "u1",
          uri: "https://github.com",
          match: "domain" as const,
        },
      ],
    };
    const view = loginDraftView(login, [
      { id: "work", name: "Work", createdAt: "2026-01-01" },
    ]);
    expect(view).toMatchObject({
      name: "GitHub",
      username: "ada",
      url: "https://github.com",
    });
    expect(JSON.stringify(view)).not.toContain("secret");
  });

  it("patches the live form and refuses when no editor is bound", () => {
    expect(() => requireLoginDraft()).toThrow("login_form_unavailable");
    const login = createItem("login", "x");
    const unbind = bindLoginDraft({
      read: () => loginDraftView(login, []),
      patch: (changes) =>
        loginDraftView(applyLoginDraftPatch(login, changes), []),
    });
    expect(requireLoginDraft().read().name).toBe("x");
    unbind();
    expect(() => requireLoginDraft()).toThrow("login_form_unavailable");
  });
});
