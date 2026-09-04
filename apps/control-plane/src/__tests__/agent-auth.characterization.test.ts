import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import {
  AGENT_AUTH_CLAIM_CSP,
  renderAgentAuthClaimPage,
  renderAgentAuthLoginPage,
  safeAgentAuthReturnTo,
} from "../ui/agent-auth-pages.js";

/**
 * Characterization snapshots for AgentAuth discovery and the service-owned
 * claim page. These pin what an agent or a human is shown so a wording or
 * advertised-capability change has to be accepted rather than discovered later.
 *
 * If a snapshot fails, read the diff before updating it:
 * - a missing `/agent/identity` is a registration road withdrawn;
 * - `identity_assertion` appearing in discovery advertises ID-JAG;
 * - a `<script>` in the claim HTML is dead under the page CSP and a bug.
 */

describe("AgentAuth characterization", () => {
  it("pins /auth.md, PRM, and AS metadata for the default enabled set", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "https://identity.example",
        issuer: "https://identity.example",
      },
    });
    const md = await (await app.request("/auth.md")).text();
    expect(md).toMatchSnapshot();
    expect(md).not.toMatch(/<script/i);

    const prm = await (
      await app.request("/.well-known/oauth-protected-resource")
    ).json();
    expect(prm).toMatchSnapshot();

    const as = await (
      await app.request("/.well-known/oauth-authorization-server")
    ).json();
    expect(as).toMatchSnapshot();
    expect(
      (as as { agent_auth: { identity_types_supported: string[] } }).agent_auth
        .identity_types_supported,
    ).toEqual(["anonymous", "service_auth"]);
  });

  it("pins the claim and login HTML a human is shown", () => {
    expect(
      renderAgentAuthClaimPage({ claimAttemptToken: "clat_fixed.secret" }),
    ).toMatchSnapshot();
    expect(renderAgentAuthClaimPage({ done: true })).toMatchSnapshot();
    expect(
      renderAgentAuthLoginPage({
        returnTo: "/claim?claim_attempt_token=clat_fixed.secret",
        publicUrl: "https://identity.example",
      }),
    ).toMatchSnapshot();
  });

  it("refuses a script tag in any claim-page snapshot", () => {
    const html = renderAgentAuthClaimPage({
      claimAttemptToken: '"><script>alert(1)</script>',
      error: "<script>alert(1)</script>",
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toMatch(/role="alert"/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('class="go"');
    expect(html).not.toMatch(/<button[^>]*>Confirm</);
  });

  it("renders an empty hidden token when none is supplied", () => {
    const html = renderAgentAuthClaimPage({});
    expect(html).toContain('name="claim_attempt_token" value=""');
    expect(html).not.toContain('role="alert"');
  });

  it("drops protocol-relative and off-site return_to values", () => {
    expect(safeAgentAuthReturnTo("//evil.example")).toBe("/claim");
    expect(safeAgentAuthReturnTo("https://evil.example")).toBe("/claim");
    expect(safeAgentAuthReturnTo("/\\evil.example")).toBe("/claim");
    expect(safeAgentAuthReturnTo("javascript:alert(1)")).toBe("/claim");
    expect(safeAgentAuthReturnTo("/claim?claim_attempt_token=x")).toBe(
      "/claim?claim_attempt_token=x",
    );
  });

  it("pins CSP and refuses an off-site login return_to on the wire", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "https://identity.example",
        issuer: "https://identity.example",
      },
    });
    const claim = await app.request(
      "/claim?claim_attempt_token=clat_fixed.secret",
    );
    expect(claim.status).toBe(303);
    expect(AGENT_AUTH_CLAIM_CSP).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    );
    expect(claim.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    );
    expect(claim.headers.get("x-frame-options")).toBe("DENY");
    expect(claim.headers.get("location")).not.toMatch(/:\/\//);

    const login = await app.request("/login?return_to=https://evil.example");
    expect(login.status).toBe(200);
    const html = await login.text();
    expect(html).toMatchSnapshot();
    expect(html).not.toContain("https://evil.example");
    expect(html).toContain('href="/claim"');
    expect(html).toContain('action="/login/start"');
    expect(html).not.toContain('href="/auth"');
    expect(login.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    );

    const started = await app.request("/login/start", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ return_to: "/claim?claim_attempt_token=x" }),
    });
    expect(started.status).toBe(303);
    const location = started.headers.get("location") ?? "";
    expect(location).toContain("/auth?");
    expect(location).toContain("client_id=opensesame-agent-auth");
    expect(location).toContain("code_challenge=");
    expect(location).not.toMatch(/return_to=https:\/\/evil/);
  });
});
