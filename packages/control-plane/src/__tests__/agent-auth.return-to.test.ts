import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import type { ControlPlaneConfig } from "../config.js";
import { createControlPlane } from "../create-app.js";
import { samlRelayPath } from "../interactions/saml.js";
import { sameOriginPath } from "../middleware/same-origin-path.js";
import { safeAgentAuthReturnTo } from "../ui/agent-auth-pages.js";

/**
 * A browser parses `Location` with the WHATWG URL parser: it strips tab and
 * newline, reads `\` as `/` and collapses `..`. Each value below passes a
 * naive "starts with one slash" test and still lands off-site.
 */
const OFF_SITE = [
  "/\t/evil.com",
  "/%09/evil.com",
  "/\n/evil.com",
  "/%0a/evil.com",
  "/\r/evil.com",
  "/ /evil.com",
  "/\u00a0/evil.com",
  "/\u200b/evil.com",
  "/..//evil.com",
  "/.//evil.com",
  "/a/../..//evil.com",
  "//evil.com",
  "/\\evil.com",
  "/%5cevil.com",
  "/%2f/evil.com",
  "\t//evil.com",
  "https://evil.com",
  "javascript:alert(1)",
  "evil.com",
  "",
];

describe("safeAgentAuthReturnTo", () => {
  it.each(OFF_SITE)("refuses %j", (value) => {
    expect(safeAgentAuthReturnTo(value)).toBe("/claim");
  });

  it.each([
    ["/claim", "/claim"],
    [
      "/claim?claim_attempt_token=clat_x.y",
      "/claim?claim_attempt_token=clat_x.y",
    ],
    ["/claim?claim_attempt_token=a%2Bb", "/claim?claim_attempt_token=a%2Bb"],
    ["/a/./b/../claim", "/a/claim"],
    ["/claim#fragment", "/claim"],
  ])("keeps the same-origin path %j", (value, expected) => {
    expect(safeAgentAuthReturnTo(value)).toBe(expected);
  });
});

describe("sameOriginPath", () => {
  const origin = "https://id.example.com";

  it("admits an absolute URL only on request and only on this origin", () => {
    expect(sameOriginPath("https://id.example.com/x", origin)).toBeUndefined();
    expect(
      sameOriginPath("https://id.example.com/x?y=1", origin, {
        allowAbsolute: true,
      }),
    ).toBe("/x?y=1");
    for (const value of [
      "https://evil.com/x",
      "http://id.example.com/x",
      "https://id.example.com//evil.com",
      "https://id.example.com/..//evil.com",
      "https:\t//evil.com",
      "::::",
    ]) {
      expect(
        sameOriginPath(value, origin, { allowAbsolute: true }),
      ).toBeUndefined();
    }
  });

  it("refuses a malformed escape instead of guessing", () => {
    expect(sameOriginPath("/%E0%A4%A", origin)).toBeUndefined();
  });

  it("gives the SAML RelayState policy the same answers", () => {
    const config: ControlPlaneConfig = overlapCast({
      publicUrl: "https://id.example.com",
    });
    for (const value of OFF_SITE) {
      expect(samlRelayPath(config, value)).toBe("/");
    }
    expect(samlRelayPath(config, "/dashboard?x=1")).toBe("/dashboard?x=1");
  });
});

describe("the login page on the wire", () => {
  const { app } = createControlPlane({
    config: {
      port: 0,
      publicUrl: "https://127.0.0.1",
      issuer: "https://127.0.0.1",
    },
  });

  it.each(["/\t/evil.com", "/..//evil.com", "/\\evil.com"])(
    "GET /login never links to %j",
    async (value) => {
      const res = await app.request(
        `/login?return_to=${encodeURIComponent(value)}`,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('href="/claim"');
      expect(html).not.toContain("evil.com");
    },
  );

  it("POST /login/start never carries an off-site return_to", async () => {
    const res = await app.request("/login/start", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ return_to: "/\t/evil.com" }),
    });
    expect(res.status).toBe(303);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(decodeURIComponent(cookie)).not.toContain("evil.com");
    expect(res.headers.get("location") ?? "").not.toContain("evil.com");
  });
});
