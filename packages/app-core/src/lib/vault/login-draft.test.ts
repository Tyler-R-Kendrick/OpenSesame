import { createItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { plainAccount } from "../account.test-support.js";
import {
  applyLoginDraftPatch,
  bindLoginDraft,
  loginDraftView,
  requireLoginDraft,
} from "./login-draft.js";

describe("login draft port", () => {
  it("projects metadata and never includes the password", () => {
    const login = {
      ...plainAccount("GitHub", "secret", { username: "ada" }),
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

  it("never lets a patch reach a method, whatever it carries", () => {
    const login = plainAccount("GitHub", "secret");
    const patched = applyLoginDraftPatch(login, {
      name: "Renamed",
      // @ts-expect-error a password is not part of the patch shape
      password: "stolen",
      pepper: "p",
    });
    expect(patched.name).toBe("Renamed");
    expect(patched.methods).toEqual(login.methods);
    expect(JSON.stringify(loginDraftView(patched, []))).not.toContain("secret");
  });

  it("refuses a draft that is not an account", () => {
    expect(() => loginDraftView(createItem("note", "n"), [])).toThrow(
      "not_an_account_draft",
    );
  });

  it("patches the live form and refuses when no editor is bound", () => {
    expect(() => requireLoginDraft()).toThrow("login_form_unavailable");
    const login = createItem("account", "x");
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
