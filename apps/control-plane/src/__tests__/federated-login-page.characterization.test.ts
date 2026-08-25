import { describe, expect, it } from "vitest";
import { renderLoginPage } from "../ui/interaction-pages.js";

/**
 * Characterization snapshots for the hosted login page.
 *
 * These do not assert that the markup is *right* — the unit and route tests
 * beside them do that. They pin exactly what a human is shown when they are
 * asked to sign in, so a change to the wording, the ordering, or the set of
 * offered providers has to be looked at and accepted rather than discovered
 * later by someone wondering why "Sign in with Google" vanished.
 *
 * If one of these fails, read the diff before updating it:
 *
 * - a provider form that disappears is a sign-in route silently withdrawn;
 * - a provider form that appears is a new party being offered the user's
 *   identity, which is an ADR 0033 §2 allowlist decision, not a UI tweak;
 * - "Start a session" moving above the providers reverses the ordering
 *   ADR 0033 §4 asks for — identity before an anonymous principal;
 * - any change under `<form … action=…>` alters where credentials are posted.
 *
 * The page ships under a CSP that forbids inline script (ADR 0050 F6), so a
 * `<script>` appearing in a snapshot is a bug that would be dead on arrival in
 * a browser and silently green in a unit test.
 */

const BASE = {
  uid: "uid-fixed-for-snapshots",
  csrfToken: "csrf-fixed-for-snapshots",
  loginAction: "/interaction/uid-fixed-for-snapshots/login",
  publicUrl: "https://identity.example",
};

const START_ACTION = "/interaction/uid-fixed-for-snapshots/federated/start";
const BYO_ACTION = "/interaction/uid-fixed-for-snapshots/federated/byo";
/** The one URI every leg returns to, shown so a visitor can register it. */
const BYO_REDIRECT_URI = "https://identity.example/v1/federated/callback";
const ORG_ACTION = "/interaction/uid-fixed-for-snapshots/federated/org";
const EMAIL_ACTION = "/interaction/uid-fixed-for-snapshots/federated/email";
const REALM_ACTION = "/interaction/uid-fixed-for-snapshots/federated/realm";
const SAML_ACTION = "/interaction/uid-fixed-for-snapshots/federated/saml";
const LDAP_ACTION = "/interaction/uid-fixed-for-snapshots/federated/ldap";

/** Every hidden field the page relies on, per form action. */
function hiddenFields(html: string, action: string): string[] {
  const start = html.indexOf(`action="${action}"`);
  if (start < 0) throw new Error(`no form posts to ${action}`);
  const end = html.indexOf("</form>", start);
  return [
    ...html
      .slice(start, end)
      .matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g),
  ].map((match) => `${match[1]}=${match[2]}`);
}

describe("hosted login page characterization", () => {
  it("offers nothing but a session when no upstream is allowlisted", () => {
    expect(renderLoginPage({ ...BASE })).toMatchSnapshot();
  });

  it("renders the production shape: Google above an anonymous session", () => {
    expect(
      renderLoginPage({
        ...BASE,
        federated: {
          startAction: START_ACTION,
          upstreams: [
            { issuer: "https://shoo.dev", label: "Google", provider: "shoo" },
          ],
        },
      }),
    ).toMatchSnapshot();
  });

  it("renders a dev stack: the local broker alongside the production one", () => {
    expect(
      renderLoginPage({
        ...BASE,
        federated: {
          startAction: START_ACTION,
          upstreams: [
            { issuer: "https://shoo.dev", label: "Google", provider: "shoo" },
            {
              issuer: "http://127.0.0.1:9090",
              label: "a local test account",
              provider: "mock",
            },
          ],
        },
      }),
    ).toMatchSnapshot();
  });

  it("promotes the hinted provider to first and primary", () => {
    expect(
      renderLoginPage({
        ...BASE,
        federated: {
          startAction: START_ACTION,
          upstreams: [
            {
              issuer: "http://127.0.0.1:9090",
              label: "a local test account",
              provider: "mock",
            },
            { issuer: "https://shoo.dev", label: "Google", provider: "shoo" },
          ],
          preferredIssuer: "https://shoo.dev",
        },
      }),
    ).toMatchSnapshot();
  });

  it("shows the continue path when a session cookie is already held", () => {
    expect(
      renderLoginPage({
        ...BASE,
        principalId: "prn_fixed",
        federated: {
          startAction: START_ACTION,
          upstreams: [
            { issuer: "https://shoo.dev", label: "Google", provider: "shoo" },
          ],
        },
      }),
    ).toMatchSnapshot();
  });

  /**
   * The full catalog page: registry providers, the organization entry with the
   * work-email router, email magic link, and bring-your-own. This is what a
   * first-time visitor sees on a fully configured deployment.
   */
  it("renders the full entry set: providers, organization, email, BYO", () => {
    expect(
      renderLoginPage({
        ...BASE,
        federated: {
          startAction: START_ACTION,
          upstreams: [
            {
              issuer: "https://accounts.google.com",
              label: "Google",
              provider: "google",
            },
            {
              issuer: "https://github.com",
              label: "GitHub",
              provider: "github",
            },
          ],
        },
        byo: { startAction: BYO_ACTION, redirectUri: BYO_REDIRECT_URI },
        org: { lookupAction: ORG_ACTION },
        email: { requestAction: EMAIL_ACTION },
        realm: { requestAction: REALM_ACTION },
      }),
    ).toMatchSnapshot();
  });

  /**
   * The second step of organization sign-in (D6): the slug resolved, so the
   * tenant's own methods are what the page leads with.
   */
  it("leads with a resolved organization's methods", () => {
    const html = renderLoginPage({
      ...BASE,
      federated: {
        startAction: START_ACTION,
        upstreams: [
          { issuer: "https://shoo.dev", label: "Google", provider: "shoo" },
        ],
      },
      org: {
        lookupAction: ORG_ACTION,
        slug: "acme",
        methods: [
          { issuer: "https://sso.acme.example", label: "SSO", kind: "sso" },
          { issuer: "https://saml.acme.example", label: "SAML", kind: "saml" },
        ],
      },
      realm: { requestAction: REALM_ACTION },
    });
    expect(html.indexOf("Continue with SSO")).toBeLessThan(
      html.indexOf("Sign in with Google"),
    );
    expect(html).toMatchSnapshot();
  });

  /**
   * Native SAML and a directory, the two tenant methods that are not an OIDC
   * redirect (ADR 0056 / C21).
   *
   * The SAML button posts the SLUG to the SAML action: a SAML entityID is a
   * name, and posting it to `/federated/start` as an issuer is refused there —
   * a button that looked right and 403'd is exactly the failure this pins. The
   * directory is not a button at all but a username and password form, and it
   * is the one place on this page a credential is typed, so what it posts to
   * and what it carries with it are worth reading in full.
   */
  it("offers native SAML and a directory form for a tenant that has them", () => {
    const html = renderLoginPage({
      ...BASE,
      federated: {
        startAction: START_ACTION,
        upstreams: [
          { issuer: "https://shoo.dev", label: "Google", provider: "shoo" },
        ],
      },
      org: {
        lookupAction: ORG_ACTION,
        slug: "acme",
        samlAction: SAML_ACTION,
        methods: [
          { kind: "sso", label: "SSO", issuer: "https://sso.acme.example" },
          { kind: "saml", label: "SAML", native: true },
        ],
      },
      ldap: { requestAction: LDAP_ACTION, slug: "acme" },
      realm: { requestAction: REALM_ACTION },
    });
    // The native method posts the tenant, not an issuer.
    expect(hiddenFields(html, SAML_ACTION)).toEqual([
      "_csrf=csrf-fixed-for-snapshots",
      "slug=acme",
    ]);
    expect(hiddenFields(html, LDAP_ACTION)).toEqual([
      "_csrf=csrf-fixed-for-snapshots",
      "slug=acme",
    ]);
    // No script anywhere: the page ships under `default-src 'none'` (T5).
    expect(html).not.toContain("<script");
    expect(html).toMatchSnapshot();
  });

  it("re-renders each block's own failure without losing the others", () => {
    expect(
      renderLoginPage({
        ...BASE,
        federated: {
          startAction: START_ACTION,
          upstreams: [
            { issuer: "https://shoo.dev", label: "Google", provider: "shoo" },
          ],
        },
        byo: {
          startAction: BYO_ACTION,
          redirectUri: BYO_REDIRECT_URI,
          error: "That provider could not be reached.",
          issuerValue: "https://id.example.com",
        },
        org: {
          lookupAction: ORG_ACTION,
          slug: "acme",
          error: "No organization sign-in is configured for that name.",
        },
        email: {
          requestAction: EMAIL_ACTION,
          sent: true,
        },
        realm: {
          requestAction: REALM_ACTION,
          error: "No organization uses that email domain.",
        },
      }),
    ).toMatchSnapshot();
  });

  /**
   * Every POST on this page is a state change, so every form carries the
   * synchronizer token; the provider forms additionally carry the registry id
   * the start route prefers over the raw issuer.
   */
  it("carries the CSRF token on every form and the provider id on the offers", () => {
    const html = renderLoginPage({
      ...BASE,
      federated: {
        startAction: START_ACTION,
        upstreams: [
          {
            issuer: "https://accounts.google.com",
            label: "Google",
            provider: "google",
          },
        ],
      },
      byo: { startAction: BYO_ACTION, redirectUri: BYO_REDIRECT_URI },
      org: { lookupAction: ORG_ACTION },
      email: { requestAction: EMAIL_ACTION },
      realm: { requestAction: REALM_ACTION },
    });

    expect(hiddenFields(html, START_ACTION)).toEqual([
      "_csrf=csrf-fixed-for-snapshots",
      "issuer=https://accounts.google.com",
      "provider=google",
    ]);
    for (const action of [
      BYO_ACTION,
      ORG_ACTION,
      EMAIL_ACTION,
      REALM_ACTION,
      BASE.loginAction,
    ]) {
      expect(hiddenFields(html, action)).toContain(
        "_csrf=csrf-fixed-for-snapshots",
      );
    }
    // No script anywhere: the CSP has no script-src, so an auto-submit or an
    // inline handler would be dead on arrival in a browser (T5).
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onsubmit");
    expect(html).not.toContain("onclick");
  });

  /**
   * Issuer and label reach this page from configuration. Pinning the escaped
   * output is the difference between a hostile label being inert text and it
   * being markup on the one page where a user types credentials.
   */
  it("escapes a hostile issuer and label rather than emitting markup", () => {
    const html = renderLoginPage({
      ...BASE,
      federated: {
        startAction: START_ACTION,
        upstreams: [
          {
            issuer: 'https://e.test/"><script>alert(1)</script>',
            label: '<img src=x onerror="alert(1)">',
            provider: '"><script>alert(2)</script>',
          },
        ],
      },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toMatchSnapshot();
  });

  /**
   * The organization slug and the BYO issuer are echoed back on a failed
   * submission — the two places on this page where a *visitor's* own text is
   * re-rendered, which is where reflected XSS lives if escaping slips.
   */
  it("escapes hostile organization and BYO values echoed back to the visitor", () => {
    const html = renderLoginPage({
      ...BASE,
      byo: {
        startAction: BYO_ACTION,
        redirectUri: BYO_REDIRECT_URI,
        issuerValue: '"><script>alert(3)</script>',
        error: '<img src=x onerror="alert(4)">',
      },
      org: {
        lookupAction: ORG_ACTION,
        slug: '"><script>alert(5)</script>',
        error: "No organization sign-in is configured for that name.",
      },
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).toMatchSnapshot();
  });
});
