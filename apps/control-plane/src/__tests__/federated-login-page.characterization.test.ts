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
          upstreams: [{ issuer: "https://shoo.dev", label: "Google" }],
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
            { issuer: "https://shoo.dev", label: "Google" },
            {
              issuer: "http://127.0.0.1:9090",
              label: "a local test account",
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
            },
            { issuer: "https://shoo.dev", label: "Google" },
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
          upstreams: [{ issuer: "https://shoo.dev", label: "Google" }],
        },
      }),
    ).toMatchSnapshot();
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
          },
        ],
      },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toMatchSnapshot();
  });
});
