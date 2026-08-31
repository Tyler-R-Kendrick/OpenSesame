import { describe, expect, it } from "vitest";
import {
  IDP_PRESETS,
  issuerFromUrl,
  presetFor,
  presetIssuer,
} from "./idp-presets.js";

describe("idp presets", () => {
  it("lists every provider type the registry contract carries", () => {
    expect(IDP_PRESETS.map((preset) => preset.type)).toEqual([
      "workos",
      "okta",
      "auth0",
      "better-auth",
    ]);
    expect(presetFor("okta")?.label).toBe("Okta");
  });

  it("pins the WorkOS issuer to AuthKit, ignoring any input", () => {
    expect(presetIssuer("workos", "")).toEqual({
      ok: true,
      issuer: "https://api.workos.com",
    });
    expect(presetIssuer("workos", "anything")).toEqual({
      ok: true,
      issuer: "https://api.workos.com",
    });
  });

  it("builds the Okta issuer from a bare org domain", () => {
    expect(presetIssuer("okta", "dev-123456.okta.com")).toEqual({
      ok: true,
      issuer: "https://dev-123456.okta.com",
    });
    expect(presetIssuer("okta", "https://dev-123456.okta.com/")).toEqual({
      ok: true,
      issuer: "https://dev-123456.okta.com",
    });
    expect(presetIssuer("okta", "acme.oktapreview.com")).toEqual({
      ok: true,
      issuer: "https://acme.oktapreview.com",
    });
  });

  it("rejects Okta inputs that are not Okta domains", () => {
    for (const input of [
      "",
      "example.com",
      "okta.com.evil.dev",
      "not a domain",
    ]) {
      const built = presetIssuer("okta", input);
      expect(built.ok, input).toBe(false);
    }
  });

  it("builds the Auth0 issuer from a tenant or custom domain", () => {
    expect(presetIssuer("auth0", "acme.auth0.com")).toEqual({
      ok: true,
      issuer: "https://acme.auth0.com",
    });
    expect(presetIssuer("auth0", "https://acme.auth0.com/")).toEqual({
      ok: true,
      issuer: "https://acme.auth0.com",
    });
    expect(presetIssuer("auth0", "login.acme.com/path")).toEqual({
      ok: true,
      issuer: "https://login.acme.com",
    });
  });

  it("rejects Auth0 inputs that are not domain-shaped", () => {
    for (const input of ["", "localhost", "not a domain", "https://"]) {
      const built = presetIssuer("auth0", input);
      expect(built.ok, input).toBe(false);
    }
  });

  it("normalizes the Better Auth deployment URL, trailing slashes off", () => {
    expect(presetIssuer("better-auth", "https://auth.acme.com/")).toEqual({
      ok: true,
      issuer: "https://auth.acme.com",
    });
    expect(presetIssuer("better-auth", "https://auth.acme.com")).toEqual({
      ok: true,
      issuer: "https://auth.acme.com",
    });
  });

  it("allows http for Better Auth only on loopback", () => {
    expect(presetIssuer("better-auth", "http://localhost:3000/")).toEqual({
      ok: true,
      issuer: "http://localhost:3000",
    });
    expect(presetIssuer("better-auth", "http://127.0.0.1:3000")).toEqual({
      ok: true,
      issuer: "http://127.0.0.1:3000",
    });
    const remote = presetIssuer("better-auth", "http://auth.acme.com");
    expect(remote.ok).toBe(false);
  });

  it("rejects Better Auth inputs that are not URLs", () => {
    for (const input of ["", "auth.acme.com", "not a url"]) {
      const built = presetIssuer("better-auth", input);
      expect(built.ok, input).toBe(false);
    }
  });
});

describe("issuerFromUrl", () => {
  it("takes the URL as entered, minus trailing slashes", () => {
    expect(issuerFromUrl("https://idp.acme.com/")).toEqual({
      ok: true,
      issuer: "https://idp.acme.com",
    });
  });

  it("allows http only on loopback", () => {
    expect(issuerFromUrl("http://localhost:8080")).toEqual({
      ok: true,
      issuer: "http://localhost:8080",
    });
    expect(issuerFromUrl("http://idp.acme.com")).toEqual({
      ok: false,
      error: "https is required, except on localhost for local dev.",
    });
  });

  it("carries the caller's wording for a malformed URL", () => {
    expect(issuerFromUrl("not a url")).toEqual({
      ok: false,
      error: "Use the issuer's base URL, like https://idp.acme.com.",
    });
    expect(issuerFromUrl("not a url", "Use the deployment URL.")).toEqual({
      ok: false,
      error: "Use the deployment URL.",
    });
  });
});
