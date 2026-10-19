import { expect, it, vi } from "vitest";
import {
  nativeBrowserMethodPolicy,
  nativeBrowserOAuthPolicy,
} from "./native-browser-policy.js";
import type { NativeBrowserPolicyCarrier } from "./native-policy-carrier.js";

function captured() {
  const lifetime = new AbortController();
  let current = true;
  const allowed = new Set([
    "https://token.example",
    "https://resource.example",
  ]);
  const supportsNativeOrigin = vi.fn((origin: string) => allowed.has(origin));
  const carrier: NativeBrowserPolicyCarrier = {
    tokenEndpoint: "https://token.example/oauth/token",
    resourceEndpoint: "https://resource.example/primary",
    transport: {
      signal: lifetime.signal,
      supportsNativeOrigin,
      assertCurrent: () => {
        if (!current) throw new Error("original owner ended");
      },
    },
  };
  return {
    carrier,
    lifetime,
    allowed,
    end: () => {
      current = false;
    },
  };
}
it("only an already captured grant covering both actual targets admits a browser-refused OAuth/MCP carrier", () => {
  const c = captured();
  expect(nativeBrowserOAuthPolicy("resend").available).toBe(false);
  expect(nativeBrowserOAuthPolicy("resend", c.carrier).available).toBe(true);
  expect(
    nativeBrowserMethodPolicy("airtable", "mcp", {}, c.carrier).available,
  ).toBe(true);
  c.allowed.delete("https://token.example");
  expect(nativeBrowserOAuthPolicy("resend", c.carrier).available).toBe(false);
  c.allowed.add("https://token.example");
  c.allowed.delete("https://resource.example");
  expect(nativeBrowserOAuthPolicy("resend", c.carrier).available).toBe(false);
});
it("stale original owner, aborted lease and retargeted origin grants never authorize a static policy override", () => {
  const ended = captured();
  ended.end();
  expect(nativeBrowserOAuthPolicy("resend", ended.carrier).available).toBe(
    false,
  );
  const aborted = captured();
  aborted.lifetime.abort();
  expect(nativeBrowserOAuthPolicy("resend", aborted.carrier).available).toBe(
    false,
  );
  const later = captured();
  later.allowed.clear();
  expect(nativeBrowserOAuthPolicy("resend", later.carrier).available).toBe(
    false,
  );
});
it("metadata, ordinary browser transport and invalid endpoint authority cannot synthesize native availability", () => {
  const c = captured();
  expect(
    nativeBrowserOAuthPolicy("resend", {
      ...c.carrier,
      transport: { assertCurrent() {} },
    }).available,
  ).toBe(false);
  for (const endpoint of [
    "http://token.example/token",
    "https://user:secret@token.example/token",
    "https://token.example/token#other",
    "",
  ])
    expect(
      nativeBrowserOAuthPolicy("resend", {
        ...c.carrier,
        tokenEndpoint: endpoint,
      }).available,
    ).toBe(false);
  expect(
    nativeBrowserMethodPolicy("airtable", "mcp", {
      supportsNativeOrigin: "true",
    }).available,
  ).toBe(false);
});
it("a predicate that withdraws its owner during inspection cannot authorize the second target", () => {
  const c = captured();
  c.carrier.transport.supportsNativeOrigin = () => {
    c.end();
    return true;
  };
  expect(nativeBrowserOAuthPolicy("resend", c.carrier).available).toBe(false);
});
