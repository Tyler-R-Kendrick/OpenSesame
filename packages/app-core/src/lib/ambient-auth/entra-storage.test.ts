/**
 * MSAL writes Web Storage itself, past the at-rest seal (ADR 0148). It keeps
 * nothing there only while two things hold: its cache lives in memory, and
 * no interactive flow runs — a redirect keeps its request (state, PKCE
 * verifier) in sessionStorage, and a redirect or popup marks SSO capability
 * in localStorage. This pins both on the one module that loads MSAL.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./entra.ts", import.meta.url), "utf8");

describe("MSAL keeps nothing in Web Storage", () => {
  it("caches tokens and accounts in memory", () => {
    expect(source).toContain('cacheLocation: "memoryStorage"');
    expect(source).not.toMatch(/cacheLocation:\s*"(session|local)Storage"/);
  });

  it("runs no interactive flow that writes its own records", () => {
    for (const call of [
      "loginRedirect",
      "loginPopup",
      "acquireTokenRedirect",
      "acquireTokenPopup",
      "handleRedirectPromise",
      "logoutRedirect",
      "logoutPopup",
    ]) {
      expect(source, call).not.toContain(`.${call}(`);
    }
  });
});
