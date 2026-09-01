import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

overlapCast(globalThis).IS_REACT_ACT_ENVIRONMENT = true;

/** Shaped exactly as `isInteractionRef` requires: `i_<base64url>.<tag>`. */
const REF = "i_AbCdEfGhIjKlMnOpQr.0123456789abcdef";
/** The canonical short link: unauthenticated, the URL a camera resolves. */
const LINK = `http://127.0.0.1:8788/i/${REF}`;
/** The versioned API: the approver's view and the two decisions. */
const API = `http://127.0.0.1:8788/v1/interactions/${REF}`;
const DIGEST = "sha256:8f14e45fceea167a5a36dedd4bea2543";
const OTHER_DIGEST = "sha256:c4ca4238a0b923820dcc509a6f75849b";

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonRes(status: number, body: BoundaryValue): Response {
  return overlapCast({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function summaryBody(over: JsonObject = {}): JsonObject {
  return {
    kind: "device_authorization",
    status: "pending",
    expiresAt: "2026-09-01T00:00:00.000Z",
    requiresApprover: true,
    ...over,
  };
}

function detailBody(over: JsonObject = {}): JsonObject {
  return {
    ...summaryBody(),
    id: "int_1",
    createdAt: "2026-08-31T23:55:00.000Z",
    requesterRef: "inbox_9f2",
    resourceRef: "acme/paperwork",
    bindingMessage: "Match 42",
    requestDigest: DIGEST,
    authorizationDetails: [],
    ...over,
  };
}

/**
 * Answer by path, not by call order.
 *
 * The screen makes a different number of calls depending on which rung of the
 * approval ladder it picks, so an ordered queue of responses would encode the
 * ladder into every test that does not care about it.
 */
interface RouteHandlers {
  resolve?: Response;
  detail?: Response;
  approve?: Response;
  deny?: Response;
}

function routes(handlers: RouteHandlers) {
  fetchMock.mockImplementation((input: BoundaryValue) => {
    const url = String(input);
    if (url.endsWith("/approve") && handlers.approve) {
      return Promise.resolve(handlers.approve);
    }
    if (url.endsWith("/deny") && handlers.deny) {
      return Promise.resolve(handlers.deny);
    }
    if (url === API && handlers.detail) {
      return Promise.resolve(handlers.detail);
    }
    if (url === LINK && handlers.resolve) {
      return Promise.resolve(handlers.resolve);
    }
    if (url.endsWith("/v1/mfa/totp/verify")) {
      return Promise.resolve(jsonRes(200, { ok: true }));
    }
    return Promise.resolve(jsonRes(500, {}));
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderApp() {
  await act(async () => {
    root.render(<App />);
  });
  await flush();
}

function buttonByText(text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!match) throw new Error(`button not found: ${text}`);
  return overlapCast(match);
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
  });
  await flush();
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function byId(id: string): HTMLInputElement {
  const node = container.querySelector(`#${id}`);
  if (!node) throw new Error(`input not found: ${id}`);
  const input: HTMLInputElement = overlapCast(node);
  return input;
}

/**
 * The recorded fetch calls, as the pair they actually are.
 *
 * `overlapCast` takes its target type from the annotation rather than a type
 * argument — esbuild cannot parse the explicit form (see `json.ts`) — so the
 * shape is declared here once instead of at every read.
 */
function calls(): [string, RequestInit][] {
  const recorded: [string, RequestInit][] = overlapCast(fetchMock.mock.calls);
  return recorded;
}

async function signIn(token = "pst_test_token") {
  await act(async () => {
    setInput(byId("session-token"), token);
  });
  await click(buttonByText("Continue"));
}

function statusText(): string {
  return container.querySelector(".status__text")?.textContent ?? "";
}

function bodyOf(suffix: string): JsonObject {
  const call = calls().find(([url]) => url.endsWith(suffix));
  if (!call) throw new Error(`no call to ${suffix}`);
  return JSON.parse(String(call[1].body));
}

beforeEach(() => {
  window.history.replaceState(null, "", `/i/${REF}`);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("resolving an interaction", () => {
  it("resolves unauthenticated and asks for sign-in before showing anything", async () => {
    routes({ resolve: jsonRes(200, summaryBody()) });
    await renderApp();

    const [url, init] = calls()[0];
    // The canonical short link, not the versioned API: this is the URL a
    // camera or a wallet pass opens.
    expect(url).toBe(LINK);
    expect(init.method).toBe("GET");
    // Scanning is not approving: no bearer leaves the device on the resolve,
    // and nothing about who is asking whom is on screen yet.
    expect(init.headers).toEqual({ accept: "application/json" });
    expect(container.textContent).toContain("Sign in to answer this request.");
    expect(container.textContent).not.toContain("inbox_9f2");
  });

  it("renders the kit's summary once the detail is read", async () => {
    routes({
      resolve: jsonRes(200, summaryBody()),
      detail: jsonRes(200, detailBody()),
    });
    await renderApp();
    await signIn();

    expect(container.querySelector("h1")?.textContent).toBe(
      "Approve this device",
    );
    expect(container.querySelector(".match__value")?.textContent).toBe(
      "Match 42",
    );
    const facts = [...container.querySelectorAll(".facts li")].map(
      (li) => li.textContent,
    );
    expect(facts).toEqual([
      "From inbox_9f2",
      "Resource acme/paperwork",
      "Expires 2026-09-01T00:00:00.000Z",
    ]);
    const detailCall = calls().find(([url]) => url === API);
    expect(detailCall?.[1].headers).toEqual({
      authorization: "Bearer pst_test_token",
    });
  });

  it("reads the detail straight away when no approver is required", async () => {
    routes({
      resolve: jsonRes(200, summaryBody({ requiresApprover: false })),
      detail: jsonRes(200, detailBody()),
    });
    await renderApp();
    expect(container.querySelector("#session-token")).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe(
      "Approve this device",
    );
  });

  it("omits the match block when there is no binding message", async () => {
    routes({
      resolve: jsonRes(200, summaryBody()),
      detail: jsonRes(200, detailBody({ bindingMessage: undefined })),
    });
    await renderApp();
    await signIn();

    expect(container.querySelector(".match")).toBeNull();
    const facts = [...container.querySelectorAll(".facts li")].map(
      (li) => li.textContent,
    );
    expect(facts).toEqual([
      "From inbox_9f2",
      "Resource acme/paperwork",
      "Expires 2026-09-01T00:00:00.000Z",
    ]);
  });

  it("renders the summary as text, never as markup", async () => {
    routes({
      resolve: jsonRes(200, summaryBody()),
      detail: jsonRes(200, detailBody({ bindingMessage: "<img src=x>ACME" })),
    });
    await renderApp();
    await signIn();

    const match = container.querySelector(".match__value");
    expect(match?.textContent).toBe("img src=xACME");
    expect(container.querySelector(".match img")).toBeNull();
  });
});

describe("approving", () => {
  it("echoes the digest and binds the proof to it", async () => {
    routes({
      resolve: jsonRes(200, summaryBody()),
      detail: jsonRes(200, detailBody()),
      approve: jsonRes(200, detailBody({ status: "approved" })),
    });
    await renderApp();
    await signIn();
    await act(async () => {
      setInput(byId("stepup-code"), "123456");
    });
    await click(buttonByText("Approve"));

    const body = bodyOf("/approve");
    expect(body.requestDigest).toBe(DIGEST);
    expect(body.proof).toEqual({
      mechanism: "session_reauth",
      boundDigest: DIGEST,
      assurance: "mfa",
      verifiedAt: expect.any(String),
    });
    expect(container.querySelector("[data-outcome]")?.textContent).toContain(
      "Approved",
    );
  });

  it("uses a passkey when the platform has one", async () => {
    Object.defineProperty(window, "PublicKeyCredential", {
      value: class PublicKeyCredential {},
      configurable: true,
    });
    Object.defineProperty(window.navigator, "credentials", {
      value: {
        get: () =>
          Promise.resolve({
            id: "cred-1",
            rawId: new Uint8Array([1]).buffer,
            type: "public-key",
            response: {
              clientDataJSON: new Uint8Array([1]).buffer,
              authenticatorData: new Uint8Array([2]).buffer,
              signature: new Uint8Array([3]).buffer,
            },
            getClientExtensionResults: () => ({}),
          }),
      },
      configurable: true,
    });
    fetchMock.mockImplementation((input: BoundaryValue) => {
      const url = String(input);
      if (url === API) return Promise.resolve(jsonRes(200, detailBody()));
      if (url.endsWith("/approve")) {
        return Promise.resolve(
          jsonRes(200, detailBody({ status: "approved" })),
        );
      }
      if (url.endsWith("/authentication-options")) {
        return Promise.resolve(jsonRes(200, { options: { challenge: "aGk" } }));
      }
      if (url.endsWith("/passkey/assert")) {
        return Promise.resolve(jsonRes(200, { ok: true }));
      }
      return Promise.resolve(jsonRes(200, summaryBody()));
    });

    await renderApp();
    await signIn();
    // No code field on the passkey rung: nothing for the human to type.
    expect(container.querySelector("#stepup-code")).toBeNull();
    await click(buttonByText("Approve"));

    expect(bodyOf("/approve").proof).toEqual({
      mechanism: "webauthn",
      boundDigest: DIGEST,
      assurance: "phishing_resistant",
      credentialRef: "cred-1",
      verifiedAt: expect.any(String),
    });

    Reflect.deleteProperty(window, "PublicKeyCredential");
    Reflect.deleteProperty(window.navigator, "credentials");
  });

  it("refuses a digest that changed since it was shown, before any fetch", async () => {
    let detail = detailBody();
    fetchMock.mockImplementation((input: BoundaryValue) => {
      const url = String(input);
      if (url === API) return Promise.resolve(jsonRes(200, detail));
      if (url === LINK) return Promise.resolve(jsonRes(200, summaryBody()));
      return Promise.resolve(jsonRes(500, {}));
    });
    await renderApp();
    await signIn();
    await act(async () => {
      setInput(byId("stepup-code"), "123456");
    });

    // The phone goes away and comes back to a request that has been rewritten
    // underneath it. The digest frozen at display time is what notices.
    detail = detailBody({ requestDigest: OTHER_DIGEST });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(statusText()).toBe(
      "This request changed since it was shown. Nothing was approved.",
    );

    const before = calls().length;
    await click(buttonByText("Approve"));

    expect(calls().length).toBe(before);
    expect(statusText()).toBe(
      "This request changed since it was shown. Nothing was approved.",
    );
    expect(container.querySelector("[data-outcome]")).toBeNull();
  });

  it("refuses an interaction that carries no digest at all, before any fetch", async () => {
    routes({
      resolve: jsonRes(200, summaryBody()),
      detail: jsonRes(200, detailBody({ requestDigest: undefined })),
    });
    await renderApp();
    await signIn();
    await act(async () => {
      setInput(byId("stepup-code"), "123456");
    });

    const before = calls().length;
    await click(buttonByText("Approve"));

    expect(calls().length).toBe(before);
    expect(statusText()).toBe("This request carries nothing to approve.");
  });

  it("refuses a transaction with no passkey available, and offers no approve", async () => {
    routes({
      resolve: jsonRes(200, summaryBody({ kind: "transaction_authorization" })),
      detail: jsonRes(200, detailBody({ kind: "transaction_authorization" })),
    });
    await renderApp();
    await signIn();

    expect(container.textContent).toContain("Needs a passkey.");
    expect(() => buttonByText("Approve")).toThrow();
    // Denying never needs a proof, so it stays available.
    expect(buttonByText("Deny").disabled).toBe(false);
  });
});

describe("denying", () => {
  it("echoes the digest and needs no proof", async () => {
    routes({
      resolve: jsonRes(200, summaryBody()),
      detail: jsonRes(200, detailBody()),
      deny: jsonRes(200, detailBody({ status: "denied" })),
    });
    await renderApp();
    await signIn();
    await click(buttonByText("Deny"));

    expect(bodyOf("/deny")).toEqual({ requestDigest: DIGEST });
    expect(
      container.querySelector("[data-outcome]")?.getAttribute("data-outcome"),
    ).toBe("denied");
  });
});

describe("terminal states", () => {
  const cases: ReadonlyArray<[string, JsonObject, string, string]> = [
    ["expired", { status: "expired" }, "expired", "Expired"],
    ["consumed", { status: "consumed" }, "consumed", "Already used"],
    ["revoked", { status: "revoked" }, "revoked", "Withdrawn"],
    ["denied", { status: "denied" }, "denied", "Denied"],
    ["approved", { status: "approved" }, "approved", "Approved"],
  ];

  for (const [name, over, outcome, text] of cases) {
    it(`renders ${name} distinctly and offers no decision`, async () => {
      routes({ resolve: jsonRes(200, summaryBody(over)) });
      await renderApp();

      const panel = container.querySelector("[data-outcome]");
      expect(panel?.getAttribute("data-outcome")).toBe(outcome);
      expect(panel?.textContent).toContain(text);
      expect(container.querySelector(".decide")).toBeNull();
      expect(container.querySelector("#session-token")).toBeNull();
    });
  }

  it("renders a 410 from the server as expired", async () => {
    routes({ resolve: jsonRes(410, { error: "interaction_expired" }) });
    await renderApp();
    expect(
      container.querySelector("[data-outcome]")?.getAttribute("data-outcome"),
    ).toBe("expired");
  });

  it("renders a 404 as not found, telling nobody whether it ever existed", async () => {
    routes({ resolve: jsonRes(404, {}) });
    await renderApp();
    const panel = container.querySelector("[data-outcome]");
    expect(panel?.getAttribute("data-outcome")).toBe("missing");
    expect(panel?.textContent).toContain("Not found");
  });

  it("offers a retry when the resolve stalls, rather than a permanent spinner", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes(500, {}))
      .mockResolvedValue(jsonRes(200, summaryBody()));
    await renderApp();
    expect(statusText()).toBe(
      "That request could not be answered. Try again shortly.",
    );
    expect(container.querySelector("h1")?.textContent).toBe("Could not load");

    await click(buttonByText("Try again"));
    expect(container.textContent).toContain("Sign in to answer this request.");
  });

  it("says so when a pasted token is rejected", async () => {
    routes({
      resolve: jsonRes(200, summaryBody()),
      detail: jsonRes(401, {}),
    });
    await renderApp();
    // Nothing pasted yet: the phase says "sign in", so the status stays silent
    // rather than repeating it.
    expect(statusText()).toBe("");
    await signIn("pst_wrong");
    expect(statusText()).toBe("That token was not accepted.");
    expect(container.querySelector("#session-token")).not.toBeNull();
  });

  it("keeps a rate limit answerable rather than terminal", async () => {
    routes({
      resolve: jsonRes(200, summaryBody()),
      detail: jsonRes(429, {}),
    });
    await renderApp();
    await signIn();
    expect(container.querySelector("[data-outcome]")).toBeNull();
    expect(statusText()).toBe("Too many attempts. Try again shortly.");
  });
});

describe("accessibility", () => {
  it("labels every field and moves focus to the heading on each phase", async () => {
    routes({
      resolve: jsonRes(200, summaryBody()),
      detail: jsonRes(200, detailBody()),
      deny: jsonRes(200, detailBody({ status: "denied" })),
    });
    await renderApp();

    // Sign-in phase: the heading has focus, and the token field has a label.
    expect(document.activeElement?.textContent).toBe("Sign in");
    const tokenLabel = container.querySelector('label[for="session-token"]');
    expect(tokenLabel?.textContent).toBe("Access token");
    expect(byId("session-token").type).toBe("password");

    await signIn();
    expect(document.activeElement?.textContent).toBe("Approve this device");
    expect(
      container.querySelector('label[for="stepup-code"]')?.textContent,
    ).toBe("Code");

    await click(buttonByText("Deny"));
    expect(document.activeElement?.textContent).toContain("Denied");
  });

  it("announces a refusal and marks it without relying on colour", async () => {
    routes({ resolve: jsonRes(200, summaryBody({ status: "revoked" })) });
    await renderApp();

    const panel = container.querySelector("[data-outcome]");
    expect(panel?.getAttribute("role")).toBe("alert");
    expect(panel?.querySelector(".outcome__mark")?.textContent).toBe("✕");
    expect(
      panel?.querySelector(".outcome__mark")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("styles deny destructively and gives both answers a touch target", async () => {
    routes({
      resolve: jsonRes(200, summaryBody()),
      detail: jsonRes(200, detailBody()),
    });
    await renderApp();
    await signIn();

    expect(buttonByText("Deny").className).toBe("danger");
    expect(buttonByText("Approve").className).toBe("primary");
    // Both live in `.decide`, which sizes them identically at 3rem.
    expect(buttonByText("Deny").parentElement?.className).toBe("decide");
    expect(buttonByText("Approve").parentElement?.className).toBe("decide");
  });

  it("keeps enrolment reachable but folded away behind the decision", async () => {
    routes({ resolve: jsonRes(200, summaryBody()) });
    await renderApp();

    const disclosure: HTMLDetailsElement = overlapCast(
      container.querySelector("details.disclosure"),
    );
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector("summary")?.textContent).toBe(
      "Authenticators",
    );
    // The approval owns the page's h1; enrolment never competes for it.
    expect(
      [...container.querySelectorAll("h1")].map((h) => h.textContent),
    ).toEqual(["Sign in"]);
  });
});
