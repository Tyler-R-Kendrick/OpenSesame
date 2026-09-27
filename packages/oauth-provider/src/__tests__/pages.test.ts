/**
 * The pages the provider draws itself load nothing from anywhere else,
 * escape what they print, and keep the provider's forms and the buttons
 * that submit them.
 */
import { overlapCast } from "@opensesame/os-domain";
import type { KoaContext } from "oidc-provider";
import { describe, expect, it } from "vitest";
import { escapeHtml, providerPages } from "../pages.js";

type Page = {
  host: string;
  type: string;
  body: string;
  oidc: { client?: { clientId: string; clientName?: string } };
};

function context(client?: Page["oidc"]["client"]): Page {
  return { host: "id.example", type: "", body: "", oidc: { client } };
}

const asKoa = (page: Page): KoaContext => overlapCast(page);

/** Every URL-bearing construct a page could use to reach another origin. */
const EXTERNAL = /https?:\/\/|@import|<link|<script|url\(/i;

describe("providerPages", () => {
  const pages = providerPages({ styles: ".btn{color:teal}" });

  it("draws an authorization error with its details escaped", async () => {
    const page = context();
    await pages.renderError(asKoa(page), {
      error: "invalid_request",
      error_description: '<img src=x onerror="alert(1)">',
      state: undefined,
    });
    expect(page.type).toBe("html");
    expect(page.body).toContain("invalid_request");
    expect(page.body).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(page.body).not.toContain("<img");
    expect(page.body).not.toContain("state");
    expect(page.body).not.toMatch(EXTERNAL);
    expect(page.body).toContain("<style>.btn{color:teal}");
  });

  it("keeps the device form and the button that submits it", async () => {
    const page = context();
    const form =
      '<form id="op.deviceInputForm"><input name="user_code"></form>';
    await pages.deviceFlow.userCodeInputSource(
      asKoa(page),
      form,
      asKoa(context()),
    );
    expect(page.body).toContain(form);
    expect(page.body).toContain('form="op.deviceInputForm"');
    // The bare field meets the touch floor: 16px text, 44px tall.
    expect(page.body).toContain("font-size:16px");
    expect(page.body).toContain("min-height:44px");
    expect(page.body).not.toMatch(EXTERNAL);
  });

  it("says a wrong code was wrong", async () => {
    const page = context();
    await pages.deviceFlow.userCodeInputSource(
      asKoa(page),
      "",
      asKoa(context()),
      { userCode: "ABCD" },
    );
    expect(page.body).toContain('role="alert"');
    expect(page.body).toContain("not right");
  });

  it("names the client and the code on the confirmation, escaped", async () => {
    const page = context({ clientId: "c1", clientName: "<b>Evil</b>" });
    await pages.deviceFlow.userCodeConfirmSource(
      asKoa(page),
      '<form id="op.deviceConfirmForm"></form>',
      asKoa(context()),
      asKoa(context()),
      "WXYZ-1234",
    );
    expect(page.body).toContain("&lt;b&gt;Evil&lt;/b&gt;");
    expect(page.body).toContain('<code class="user-code">WXYZ-1234</code>');
    expect(page.body).toContain(".user-code{font-size:1.75rem");
    expect(page.body).toContain('name="abort"');
    expect(page.body).not.toMatch(EXTERNAL);
  });

  it("asks before signing out, and keeps both answers", async () => {
    const page = context();
    await pages.rpInitiatedLogout.logoutSource(
      asKoa(page),
      '<form id="op.logoutForm"></form>',
    );
    expect(page.body).toContain("id.example");
    expect(page.body).toContain('name="logout"');
    expect(page.body.match(/form="op\.logoutForm"/g)).toHaveLength(2);
    expect(page.body).not.toMatch(EXTERNAL);
  });

  it("confirms a sign-out and a device sign-in", async () => {
    const out = context({ clientId: "app-1" });
    await pages.rpInitiatedLogout.postLogoutSuccessSource(asKoa(out));
    expect(out.body).toContain("app-1");
    const done = context({ clientId: "c1", clientName: "Tool" });
    await pages.deviceFlow.successSource(asKoa(done));
    expect(done.body).toContain("with Tool");
  });

  it("falls back to a plain stylesheet that still fetches nothing", async () => {
    const page = context();
    await providerPages().renderError(asKoa(page), { error: "server_error" });
    expect(page.body).toMatch(/<style>[^<]+<\/style>/);
    expect(page.body).not.toMatch(EXTERNAL);
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters that matter in text and attributes", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});
