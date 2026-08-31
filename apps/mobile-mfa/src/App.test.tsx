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

function badJsonRes(status: number): Response {
  return overlapCast({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new Error("invalid json")),
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
  const match = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  );
  if (!match) throw new Error(`button not found: ${text}`);
  return overlapCast(match);
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

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
  });
  await flush();
}

/**
 * The message, without the non-colour mark beside it.
 *
 * `.status__text` rather than the whole paragraph: every status now carries a
 * glyph so its meaning does not depend on the panel's colour, and asserting on
 * the paragraph's text would fold that glyph into every expectation.
 */
function statusText(): string {
  return container.querySelector(".status__text")?.textContent ?? "";
}

async function enterToken(token = "pst_test_token") {
  await act(async () => {
    setInput(byId("session-token"), token);
  });
}

function installWebAuthn({
  create,
  get,
}: {
  create?: () => Promise<BoundaryValue>;
  get?: () => Promise<BoundaryValue>;
}) {
  Object.defineProperty(window, "PublicKeyCredential", {
    value: class PublicKeyCredential {},
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window.navigator, "credentials", {
    value: {
      create: create ?? (() => Promise.resolve(null)),
      get: get ?? (() => Promise.resolve(null)),
    },
    configurable: true,
  });
}

function fakeRegistrationCredential() {
  return {
    id: "cred-1",
    rawId: new Uint8Array([1, 2, 3]).buffer,
    type: "public-key",
    response: {
      clientDataJSON: new Uint8Array([1]).buffer,
      attestationObject: new Uint8Array([2]).buffer,
      getTransports: () => ["internal"],
    },
    getClientExtensionResults: () => ({}),
  };
}

function fakeAssertionCredential() {
  return {
    id: "cred-1",
    rawId: new Uint8Array([1]).buffer,
    type: "public-key",
    response: {
      clientDataJSON: new Uint8Array([1]).buffer,
      authenticatorData: new Uint8Array([2]).buffer,
      signature: new Uint8Array([3]).buffer,
    },
    getClientExtensionResults: () => ({}),
  };
}

const REGISTRATION_OPTIONS: JsonObject = {
  options: {
    rp: { name: "OpenSesame" },
    user: { id: "aA", name: "dev", displayName: "Dev" },
    challenge: "aGk",
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  },
};

beforeEach(() => {
  window.history.replaceState(null, "", "/");
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
  Reflect.deleteProperty(window, "PublicKeyCredential");
  Reflect.deleteProperty(window.navigator, "credentials");
});

describe("App initial render", () => {
  it("shows the standalone surface when no link was opened", async () => {
    await renderApp();
    expect(
      [...container.querySelectorAll("h1")].map((h) => h.textContent),
    ).toEqual(["Mobile MFA"]);
    expect(container.textContent).not.toContain("is not settled here");
    // Nothing has happened yet, so there is nothing to say about it. The old
    // surface opened on "Ready for step-up", which is a caption on a blank
    // form rather than news.
    expect(container.querySelector(".status")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leads with the approval when a legacy user code is on the link", async () => {
    window.history.replaceState(null, "", "/?user_code=abcd-efgh");
    await renderApp();
    // Uppercased on the way in by `parseLegacyInteractionLink`. The app's old
    // parser passed the value through untouched, so the same code reached the
    // server in whichever case it was typed.
    expect(byId("user-code").value).toBe("ABCD-EFGH");
    expect(
      [...container.querySelectorAll("h1")].map((h) => h.textContent),
    ).toEqual(["Approve this device"]);
  });

  it("uppercases a user code typed into the input", async () => {
    await renderApp();
    await act(async () => {
      setInput(byId("user-code"), "wxyz-1234");
    });
    expect(byId("user-code").value).toBe("WXYZ-1234");
  });

  it("reads the link exactly once, and not again on history events", async () => {
    await renderApp();
    window.history.replaceState(null, "", "/?user_code=HASH-0001#x");
    await act(async () => {
      window.dispatchEvent(new Event("hashchange"));
      window.dispatchEvent(new Event("popstate"));
    });
    // The old app listened for both and re-ran a parser that read query
    // parameters — a listener that could not fire for what it parsed, and a
    // second way into a ceremony that has one. A link now decides the screen
    // once, at mount.
    expect(byId("user-code").value).toBe("");
    expect(
      [...container.querySelectorAll("h1")].map((h) => h.textContent),
    ).toEqual(["Mobile MFA"]);
  });
});

describe("checkIdentity", () => {
  it("reports ok when the health endpoint responds 200", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, {}));
    await renderApp();
    await click(buttonByText("Check Identity API"));
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8788/v1/health/live",
    );
    expect(statusText()).toBe("Identity API reachable");
  });

  it("reports the status code when the health endpoint fails", async () => {
    fetchMock.mockResolvedValue(jsonRes(503, {}));
    await renderApp();
    await click(buttonByText("Check Identity API"));
    expect(statusText()).toBe("Identity API returned 503");
  });

  it("reports offline when fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("connection refused"));
    await renderApp();
    await click(buttonByText("Check Identity API"));
    expect(statusText()).toBe("Identity API offline: connection refused");
  });
});

describe("device approval", () => {
  it("rejects an empty user code before any fetch, in the kit's words", async () => {
    await renderApp();
    await click(buttonByText("Approve"));
    expect(statusText()).toBe("Enter the user code shown on the device.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts only the user code, carrying the bearer on the headers", async () => {
    window.history.replaceState(null, "", "/?user_code=ABCD-EFGH");
    fetchMock.mockResolvedValue(jsonRes(200, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Approve"));

    const [url, init] = overlapCast(fetchMock.mock.calls[0]);
    expect(url).toBe("http://127.0.0.1:8788/v1/device/approve");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    // No `principal`. The Identity API documents the field as ignored
    // (apps/control-plane/src/openapi.ts), so the free-text box that used to
    // fill it was telling the human it decided something it never did.
    expect(JSON.parse(overlapCast(init.body))).toEqual({
      user_code: "ABCD-EFGH",
    });
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer pst_test_token",
    );
    expect(statusText()).toBe("Approved ABCD-EFGH.");
  });

  it("sends no authorization header when no token was pasted", async () => {
    window.history.replaceState(null, "", "/?user_code=ABCD-EFGH");
    fetchMock.mockResolvedValue(jsonRes(200, {}));
    await renderApp();
    await click(buttonByText("Approve"));
    const [, init] = overlapCast(fetchMock.mock.calls[0]);
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("prompts for sign-in on 403", async () => {
    window.history.replaceState(null, "", "/?user_code=ABCD-EFGH");
    fetchMock.mockResolvedValue(jsonRes(403, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Approve"));
    expect(statusText()).toContain("Sign in first, then approve this code.");
  });

  it("prompts for sign-in on a bare 401", async () => {
    window.history.replaceState(null, "", "/?user_code=ABCD-EFGH");
    fetchMock.mockResolvedValue(jsonRes(401, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Approve"));
    expect(statusText()).toContain("Sign in first, then approve this code.");
  });

  it("distinguishes a code that was never there from a rejected caller", async () => {
    window.history.replaceState(null, "", "/?user_code=ABCD-EFGH");
    fetchMock.mockResolvedValue(jsonRes(404, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Approve"));
    // The app's own copy had no 404 branch at all: an expired code and a
    // server error read identically.
    expect(statusText()).toBe("That user code was not found or has expired.");
  });

  it("reports the status code for other failures", async () => {
    window.history.replaceState(null, "", "/?user_code=ABCD-EFGH");
    fetchMock.mockResolvedValue(jsonRes(500, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Approve"));
    expect(statusText()).toBe("Approval failed (500). Try again shortly.");
  });

  it("reports a transport failure without quoting it", async () => {
    window.history.replaceState(null, "", "/?user_code=ABCD-EFGH");
    fetchMock.mockRejectedValue(new Error("down"));
    await renderApp();
    await enterToken();
    await click(buttonByText("Approve"));
    expect(statusText()).toBe("The Identity API did not answer.");
  });
});

describe("registerPasskey", () => {
  it("requires an access token first", async () => {
    await renderApp();
    await click(buttonByText("Register passkey"));
    expect(statusText()).toContain("Paste a session access token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails when the browser lacks WebAuthn support", async () => {
    await renderApp();
    await enterToken();
    await click(buttonByText("Register passkey"));
    expect(statusText()).toBe("This browser does not support WebAuthn.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the server hint when registration options fail", async () => {
    installWebAuthn({});
    fetchMock.mockResolvedValue(
      jsonRes(400, { error: "bad", hint: "session expired" }),
    );
    await renderApp();
    await enterToken();
    await click(buttonByText("Register passkey"));
    expect(statusText()).toBe("session expired");
  });

  it("falls back to a status message when the body has no hint or error", async () => {
    installWebAuthn({});
    fetchMock.mockResolvedValue(jsonRes(500, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register passkey"));
    expect(statusText()).toBe("Registration options failed (500)");
  });

  it("reports cancellation when the authenticator returns no credential", async () => {
    installWebAuthn({ create: () => Promise.resolve(null) });
    fetchMock.mockResolvedValue(jsonRes(200, REGISTRATION_OPTIONS));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register passkey"));
    expect(statusText()).toBe("Passkey creation was cancelled.");
  });

  it("reports register endpoint failures", async () => {
    installWebAuthn({
      create: () => Promise.resolve(fakeRegistrationCredential()),
    });
    fetchMock
      .mockResolvedValueOnce(jsonRes(200, REGISTRATION_OPTIONS))
      .mockResolvedValueOnce(jsonRes(400, { error: "attestation rejected" }));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register passkey"));
    expect(statusText()).toBe("attestation rejected");
  });

  it("completes the full register + assert ceremony", async () => {
    installWebAuthn({
      create: () => Promise.resolve(fakeRegistrationCredential()),
      get: () => Promise.resolve(fakeAssertionCredential()),
    });
    fetchMock
      .mockResolvedValueOnce(jsonRes(200, REGISTRATION_OPTIONS))
      .mockResolvedValueOnce(jsonRes(200, { principalId: "prn_dev" }))
      .mockResolvedValueOnce(
        jsonRes(200, {
          options: {
            challenge: "aGk",
            allowCredentials: [{ id: "aA", type: "public-key" }],
          },
        }),
      )
      .mockResolvedValueOnce(jsonRes(200, { principalId: "prn_dev" }));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register passkey"));
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual([
      "http://127.0.0.1:8788/v1/mfa/passkey/registration-options",
      "http://127.0.0.1:8788/v1/mfa/passkey/register",
      "http://127.0.0.1:8788/v1/mfa/passkey/authentication-options",
      "http://127.0.0.1:8788/v1/mfa/passkey/assert",
    ]);
    expect(statusText()).toBe("Passkey registered for prn_dev.");
  });

  it("reports a credential that registered but could not be asserted", async () => {
    installWebAuthn({
      create: () => Promise.resolve(fakeRegistrationCredential()),
    });
    fetchMock
      .mockResolvedValueOnce(jsonRes(200, REGISTRATION_OPTIONS))
      .mockResolvedValueOnce(jsonRes(200, { principalId: "prn_dev" }))
      .mockResolvedValueOnce(jsonRes(500, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register passkey"));
    // Registration succeeded, so this is not a failed enrolment. Reporting it
    // as one would send the human off to register a second credential.
    expect(statusText()).toBe(
      "Passkey registered for prn_dev, but not asserted: Passkey options failed (500)",
    );
  });

  it("reports a cancelled assertion without losing the registration", async () => {
    installWebAuthn({
      create: () => Promise.resolve(fakeRegistrationCredential()),
      get: () => Promise.resolve(null),
    });
    fetchMock
      .mockResolvedValueOnce(jsonRes(200, REGISTRATION_OPTIONS))
      .mockResolvedValueOnce(jsonRes(200, { principalId: "prn_dev" }))
      .mockResolvedValueOnce(jsonRes(200, { options: { challenge: "aGk" } }));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register passkey"));
    expect(statusText()).toBe(
      "Passkey registered for prn_dev, but not asserted: Passkey cancelled.",
    );
  });

  it("reports when the final assert call fails", async () => {
    installWebAuthn({
      create: () => Promise.resolve(fakeRegistrationCredential()),
      get: () => Promise.resolve(fakeAssertionCredential()),
    });
    fetchMock
      .mockResolvedValueOnce(jsonRes(200, REGISTRATION_OPTIONS))
      .mockResolvedValueOnce(jsonRes(200, { principalId: "prn_dev" }))
      .mockResolvedValueOnce(jsonRes(200, { options: { challenge: "aGk" } }))
      .mockResolvedValueOnce(jsonRes(400, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register passkey"));
    expect(statusText()).toBe(
      "Passkey registered for prn_dev, but not asserted: Passkey rejected.",
    );
  });

  it("reports a generic message for non-Error ceremony failures", async () => {
    installWebAuthn({ create: () => Promise.reject("raw string failure") });
    fetchMock.mockResolvedValue(jsonRes(200, REGISTRATION_OPTIONS));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register passkey"));
    expect(statusText()).toBe("Passkey ceremony failed");
  });

  it("tolerates a non-JSON registration options body", async () => {
    installWebAuthn({});
    fetchMock.mockResolvedValue(badJsonRes(200));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register passkey"));
    expect(statusText()).toBe("Registration options failed (200)");
  });

  it("tolerates a non-JSON register response body", async () => {
    installWebAuthn({
      create: () => Promise.resolve(fakeRegistrationCredential()),
    });
    fetchMock
      .mockResolvedValueOnce(jsonRes(200, REGISTRATION_OPTIONS))
      .mockResolvedValueOnce(badJsonRes(400));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register passkey"));
    expect(statusText()).toBe("Passkey register failed (400)");
  });

  it("labels the principal as session when registration omits it", async () => {
    installWebAuthn({
      create: () => Promise.resolve(fakeRegistrationCredential()),
      get: () => Promise.resolve(fakeAssertionCredential()),
    });
    fetchMock
      .mockResolvedValueOnce(jsonRes(200, REGISTRATION_OPTIONS))
      .mockResolvedValueOnce(jsonRes(200, {}))
      .mockResolvedValueOnce(jsonRes(200, { options: { challenge: "aGk" } }))
      .mockResolvedValueOnce(jsonRes(200, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register passkey"));
    expect(statusText()).toBe("Passkey registered for session.");
  });

  it("reports unexpected ceremony errors", async () => {
    installWebAuthn({
      create: () => Promise.reject(new Error("authenticator exploded")),
    });
    fetchMock.mockResolvedValue(jsonRes(200, REGISTRATION_OPTIONS));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register passkey"));
    expect(statusText()).toBe("authenticator exploded");
  });
});

describe("TOTP enroll + verify", () => {
  it("requires an access token before enrolling", async () => {
    await renderApp();
    await click(buttonByText("Enroll TOTP"));
    expect(statusText()).toContain("Paste a session access token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the QR code and secret after a successful enroll", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(200, {
        secret: "SECRETPAYLOAD",
        otpauthUrl: "otpauth://totp/dev?secret=SECRETPAYLOAD",
      }),
    );
    await renderApp();
    await enterToken();
    await click(buttonByText("Enroll TOTP"));
    expect(statusText()).toBe("TOTP enrolled. Scan or copy the secret.");
    expect(container.textContent).toContain("Secret (base64): SECRETPAYLOAD");
    expect(container.textContent).toContain(
      "otpauth://totp/dev?secret=SECRETPAYLOAD",
    );
    expect(container.querySelector("img.qr")).not.toBeNull();
  });

  it("shows only the secret when no otpauth URL is returned", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { secret: "ONLYSECRET" }));
    await renderApp();
    await enterToken();
    await click(buttonByText("Enroll TOTP"));
    expect(container.textContent).toContain("Secret (base64): ONLYSECRET");
    expect(container.querySelector("img.qr")).toBeNull();
  });

  it("handles a successful enroll that returns no secret material", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Enroll TOTP"));
    expect(statusText()).toBe("TOTP enrolled. Scan or copy the secret.");
    expect(container.textContent).not.toContain("Secret (base64):");
    expect(container.querySelector("div.totp-enroll")).toBeNull();
  });

  it("tolerates a non-JSON enroll response body", async () => {
    fetchMock.mockResolvedValue(badJsonRes(500));
    await renderApp();
    await enterToken();
    await click(buttonByText("Enroll TOTP"));
    expect(statusText()).toBe("TOTP enroll failed (500)");
  });

  it("surfaces the server hint when enroll fails", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(403, { hint: "dev defaults disabled" }),
    );
    await renderApp();
    await enterToken();
    await click(buttonByText("Enroll TOTP"));
    expect(statusText()).toBe("dev defaults disabled");
  });

  it("falls back to a status message when enroll fails without a body", async () => {
    fetchMock.mockResolvedValue(jsonRes(500, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Enroll TOTP"));
    expect(statusText()).toBe("TOTP enroll failed (500)");
  });

  it("requires an access token before verifying", async () => {
    await renderApp();
    await click(buttonByText("Verify TOTP"));
    expect(statusText()).toContain("Paste a session access token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the code and reports a successful verify", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { ok: true }));
    await renderApp();
    await enterToken();
    await act(async () => {
      setInput(byId("totp-code"), "123456");
    });
    await click(buttonByText("Verify TOTP"));
    const [url, init] = overlapCast(fetchMock.mock.calls[0]);
    expect(url).toBe("http://127.0.0.1:8788/v1/mfa/totp/verify");
    expect(JSON.parse(overlapCast(init.body))).toEqual({ code: "123456" });
    expect(statusText()).toBe("TOTP verified");
  });

  it("tolerates a non-JSON verify response body", async () => {
    fetchMock.mockResolvedValue(badJsonRes(200));
    await renderApp();
    await enterToken();
    await click(buttonByText("Verify TOTP"));
    expect(statusText()).toBe("TOTP verification failed");
  });

  it("reports failure when the server rejects the code", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { ok: false }));
    await renderApp();
    await enterToken();
    await click(buttonByText("Verify TOTP"));
    expect(statusText()).toBe("TOTP verification failed");
  });

  it("reports failure when the verify request itself fails", async () => {
    fetchMock.mockResolvedValue(jsonRes(500, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Verify TOTP"));
    expect(statusText()).toBe("TOTP verification failed");
  });
});

describe("accessibility of the standalone surface", () => {
  it("wires every label to its field", async () => {
    await renderApp();
    const pairs = [...container.querySelectorAll("label")].map((label) => [
      label.getAttribute("for"),
      label.textContent,
    ]);
    expect(pairs).toEqual([
      ["session-token", "Access token"],
      ["user-code", "User code"],
      ["totp-code", "TOTP code"],
    ]);
    for (const [id] of pairs) {
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it("marks a failure with a glyph as well as a colour, and announces it", async () => {
    await renderApp();
    await click(buttonByText("Enroll TOTP"));
    const status = container.querySelector(".status");
    expect(status?.getAttribute("role")).toBe("alert");
    expect(status?.querySelector(".status__mark")?.textContent).toBe("!");
    expect(
      status?.querySelector(".status__mark")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });
});
