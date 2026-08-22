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

function userCodeInput(): HTMLInputElement {
  const input = overlapCast(
    container.querySelector('input[placeholder="ABCD-EFGH"]'),
  );
  if (!input) throw new Error("user code input not found");
  return input;
}

function tokenInput(): HTMLInputElement {
  const input = overlapCast(container.querySelector('input[type="password"]'));
  if (!input) throw new Error("token input not found");
  return input;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
  });
  await flush();
}

function statusText(): string {
  const el = container.querySelector("p.status");
  return el?.textContent ?? "";
}

async function enterToken(token = "pst_test_token") {
  await act(async () => {
    setInput(tokenInput(), token);
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
  it("shows the ready status and no claim hint without deep-link params", async () => {
    await renderApp();
    expect(statusText()).toContain("Ready for step-up");
    expect(container.textContent).not.toContain("Deep-link claim id");
    // no priority section without a user code
    expect(container.querySelector("section.priority")).toBeNull();
  });

  it("reads the user code from ?user_code= and pre-fills the input", async () => {
    window.history.replaceState(null, "", "/?user_code=abcd-efgh");
    await renderApp();
    expect(userCodeInput().value).toBe("abcd-efgh");
    expect(statusText()).toContain(
      "Deep-link user code abcd-efgh — review and approve",
    );
    expect(container.querySelector("section.priority")).not.toBeNull();
  });

  it("uppercases user code typed into the input", async () => {
    await renderApp();
    await act(async () => {
      setInput(userCodeInput(), "wxyz-1234");
    });
    expect(userCodeInput().value).toBe("WXYZ-1234");
  });

  it("updates the user code when a hashchange arrives with new params", async () => {
    await renderApp();
    window.history.replaceState(null, "", "/?user_code=HASH-0001#x");
    await act(async () => {
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(userCodeInput().value).toBe("HASH-0001");
    expect(statusText()).toContain("Deep-link user code HASH-0001");
  });

  it("ignores popstate events without a user code", async () => {
    await renderApp();
    await act(async () => {
      window.dispatchEvent(new Event("popstate"));
    });
    expect(statusText()).toContain("Ready for step-up");
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

describe("approveDevice", () => {
  it("rejects an empty user code before any fetch", async () => {
    await renderApp();
    await click(buttonByText("Approve device code"));
    expect(statusText()).toBe("Enter the user code from your terminal.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an access token before approving", async () => {
    window.history.replaceState(null, "", "/?user_code=ABCD-EFGH");
    await renderApp();
    await click(buttonByText("Approve device code"));
    expect(statusText()).toContain("Paste a session access token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the approval and reports success", async () => {
    window.history.replaceState(null, "", "/?user_code=ABCD-EFGH");
    fetchMock.mockResolvedValue(jsonRes(200, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Approve device code"));
    const [url, init] = overlapCast(fetchMock.mock.calls[0]);
    expect(url).toBe("http://127.0.0.1:8788/v1/device/approve");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(overlapCast(init.body))).toEqual({
      user_code: "ABCD-EFGH",
      principal: "",
    });
    expect(statusText()).toBe(
      "Device code ABCD-EFGH approved via Identity API",
    );
  });

  it("sends the principal id when one is entered", async () => {
    window.history.replaceState(null, "", "/?user_code=ABCD-EFGH");
    fetchMock.mockResolvedValue(jsonRes(200, {}));
    await renderApp();
    const principalLabel = [...container.querySelectorAll("label")].find((l) =>
      l.textContent?.includes("Principal id"),
    );
    const principalInput = overlapCast(principalLabel?.querySelector("input"));
    await act(async () => {
      setInput(principalInput, "prn_operator");
    });
    await enterToken();
    await click(buttonByText("Approve device code"));
    const [, init] = overlapCast(fetchMock.mock.calls[0]);
    expect(JSON.parse(overlapCast(init.body))).toEqual({
      user_code: "ABCD-EFGH",
      principal: "prn_operator",
    });
  });

  it("prompts for sign-in on 401/403", async () => {
    window.history.replaceState(null, "", "/?user_code=ABCD-EFGH");
    fetchMock.mockResolvedValue(jsonRes(403, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Approve device code"));
    expect(statusText()).toBe(
      "Sign in or provide a valid token, then try again.",
    );
  });

  it("prompts for sign-in on a bare 401", async () => {
    window.history.replaceState(null, "", "/?user_code=ABCD-EFGH");
    fetchMock.mockResolvedValue(jsonRes(401, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Approve device code"));
    expect(statusText()).toBe(
      "Sign in or provide a valid token, then try again.",
    );
  });

  it("reports the status code for other failures", async () => {
    window.history.replaceState(null, "", "/?user_code=ABCD-EFGH");
    fetchMock.mockResolvedValue(jsonRes(500, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Approve device code"));
    expect(statusText()).toBe("Approve failed (500)");
  });

  it("reports offline when fetch throws", async () => {
    window.history.replaceState(null, "", "/?user_code=ABCD-EFGH");
    fetchMock.mockRejectedValue(new Error("down"));
    await renderApp();
    await enterToken();
    await click(buttonByText("Approve device code"));
    expect(statusText()).toBe("Identity API offline: down");
  });
});

describe("registerPasskey", () => {
  it("requires an access token first", async () => {
    await renderApp();
    await click(buttonByText("Register + assert passkey"));
    expect(statusText()).toContain("Paste a session access token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails when the browser lacks WebAuthn support", async () => {
    await renderApp();
    await enterToken();
    await click(buttonByText("Register + assert passkey"));
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
    await click(buttonByText("Register + assert passkey"));
    expect(statusText()).toBe("session expired");
  });

  it("falls back to a status message when the body has no hint or error", async () => {
    installWebAuthn({});
    fetchMock.mockResolvedValue(jsonRes(500, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register + assert passkey"));
    expect(statusText()).toBe("Registration options failed (500)");
  });

  it("reports cancellation when the authenticator returns no credential", async () => {
    installWebAuthn({ create: () => Promise.resolve(null) });
    fetchMock.mockResolvedValue(
      jsonRes(200, {
        options: {
          rp: { name: "OpenSesame" },
          user: { id: "aA", name: "dev", displayName: "Dev" },
          challenge: "aGk",
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        },
      }),
    );
    await renderApp();
    await enterToken();
    await click(buttonByText("Register + assert passkey"));
    expect(statusText()).toBe("Passkey creation was cancelled.");
  });

  it("reports register endpoint failures", async () => {
    installWebAuthn({
      create: () => Promise.resolve(fakeRegistrationCredential()),
    });
    fetchMock
      .mockResolvedValueOnce(
        jsonRes(200, {
          options: {
            rp: { name: "OpenSesame" },
            user: { id: "aA", name: "dev", displayName: "Dev" },
            challenge: "aGk",
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          },
        }),
      )
      .mockResolvedValueOnce(jsonRes(400, { error: "attestation rejected" }));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register + assert passkey"));
    expect(statusText()).toBe("attestation rejected");
  });

  it("completes the full register + assert ceremony", async () => {
    installWebAuthn({
      create: () => Promise.resolve(fakeRegistrationCredential()),
      get: () => Promise.resolve(fakeAssertionCredential()),
    });
    fetchMock
      .mockResolvedValueOnce(
        jsonRes(200, {
          options: {
            rp: { name: "OpenSesame" },
            user: { id: "aA", name: "dev", displayName: "Dev" },
            challenge: "aGk",
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            excludeCredentials: [{ id: "aA", type: "public-key" }],
          },
        }),
      )
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
    await click(buttonByText("Register + assert passkey"));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const urls = fetchMock.mock.calls.map(([u]) => u);
    expect(urls).toEqual([
      "http://127.0.0.1:8788/v1/mfa/passkey/registration-options",
      "http://127.0.0.1:8788/v1/mfa/passkey/register",
      "http://127.0.0.1:8788/v1/mfa/passkey/authentication-options",
      "http://127.0.0.1:8788/v1/mfa/passkey/assert",
    ]);
    expect(statusText()).toBe("Passkey registered and asserted for prn_dev");
  });

  it("degrades gracefully when assert options are unavailable", async () => {
    installWebAuthn({
      create: () => Promise.resolve(fakeRegistrationCredential()),
    });
    fetchMock
      .mockResolvedValueOnce(
        jsonRes(200, {
          options: {
            rp: { name: "OpenSesame" },
            user: { id: "aA", name: "dev", displayName: "Dev" },
            challenge: "aGk",
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          },
        }),
      )
      .mockResolvedValueOnce(jsonRes(200, { principalId: "prn_dev" }))
      .mockResolvedValueOnce(jsonRes(500, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register + assert passkey"));
    expect(statusText()).toBe(
      "Passkey registered for prn_dev — assert options unavailable",
    );
  });

  it("stops after registration when the assertion is cancelled", async () => {
    installWebAuthn({
      create: () => Promise.resolve(fakeRegistrationCredential()),
      get: () => Promise.resolve(null),
    });
    fetchMock
      .mockResolvedValueOnce(
        jsonRes(200, {
          options: {
            rp: { name: "OpenSesame" },
            user: { id: "aA", name: "dev", displayName: "Dev" },
            challenge: "aGk",
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          },
        }),
      )
      .mockResolvedValueOnce(jsonRes(200, { principalId: "prn_dev" }))
      .mockResolvedValueOnce(jsonRes(200, { options: { challenge: "aGk" } }));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register + assert passkey"));
    expect(statusText()).toBe("Passkey registered for prn_dev");
  });

  it("reports when the final assert call fails", async () => {
    installWebAuthn({
      create: () => Promise.resolve(fakeRegistrationCredential()),
      get: () => Promise.resolve(fakeAssertionCredential()),
    });
    fetchMock
      .mockResolvedValueOnce(
        jsonRes(200, {
          options: {
            rp: { name: "OpenSesame" },
            user: { id: "aA", name: "dev", displayName: "Dev" },
            challenge: "aGk",
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          },
        }),
      )
      .mockResolvedValueOnce(jsonRes(200, { principalId: "prn_dev" }))
      .mockResolvedValueOnce(jsonRes(200, { options: { challenge: "aGk" } }))
      .mockResolvedValueOnce(jsonRes(400, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register + assert passkey"));
    expect(statusText()).toBe("Passkey assert failed");
  });

  it("reports a generic message for non-Error ceremony failures", async () => {
    installWebAuthn({
      create: () => Promise.reject("raw string failure"),
    });
    fetchMock.mockResolvedValue(
      jsonRes(200, {
        options: {
          rp: { name: "OpenSesame" },
          user: { id: "aA", name: "dev", displayName: "Dev" },
          challenge: "aGk",
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        },
      }),
    );
    await renderApp();
    await enterToken();
    await click(buttonByText("Register + assert passkey"));
    expect(statusText()).toBe("Passkey ceremony failed");
  });

  it("tolerates a non-JSON registration options body", async () => {
    installWebAuthn({});
    fetchMock.mockResolvedValue(badJsonRes(200));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register + assert passkey"));
    expect(statusText()).toBe("Registration options failed (200)");
  });

  it("tolerates a non-JSON register response body", async () => {
    installWebAuthn({
      create: () => Promise.resolve(fakeRegistrationCredential()),
    });
    fetchMock
      .mockResolvedValueOnce(
        jsonRes(200, {
          options: {
            rp: { name: "OpenSesame" },
            user: { id: "aA", name: "dev", displayName: "Dev" },
            challenge: "aGk",
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          },
        }),
      )
      .mockResolvedValueOnce(badJsonRes(400));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register + assert passkey"));
    expect(statusText()).toBe("Passkey register failed (400)");
  });

  it("falls back to the registered principal when assert omits it", async () => {
    installWebAuthn({
      create: () => Promise.resolve(fakeRegistrationCredential()),
      get: () => Promise.resolve(fakeAssertionCredential()),
    });
    fetchMock
      .mockResolvedValueOnce(
        jsonRes(200, {
          options: {
            rp: { name: "OpenSesame" },
            user: { id: "aA", name: "dev", displayName: "Dev" },
            challenge: "aGk",
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          },
        }),
      )
      .mockResolvedValueOnce(jsonRes(200, { principalId: "prn_dev" }))
      .mockResolvedValueOnce(jsonRes(200, { options: { challenge: "aGk" } }))
      .mockResolvedValueOnce(jsonRes(200, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register + assert passkey"));
    expect(statusText()).toBe("Passkey registered and asserted for prn_dev");
  });

  it("labels the principal as session when registration omits it", async () => {
    installWebAuthn({
      create: () => Promise.resolve(fakeRegistrationCredential()),
    });
    fetchMock
      .mockResolvedValueOnce(
        jsonRes(200, {
          options: {
            rp: { name: "OpenSesame" },
            user: { id: "aA", name: "dev", displayName: "Dev" },
            challenge: "aGk",
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          },
        }),
      )
      .mockResolvedValueOnce(jsonRes(200, {}))
      .mockResolvedValueOnce(jsonRes(500, {}));
    await renderApp();
    await enterToken();
    await click(buttonByText("Register + assert passkey"));
    expect(statusText()).toBe(
      "Passkey registered for session — assert options unavailable",
    );
  });

  it("reports unexpected ceremony errors", async () => {
    installWebAuthn({
      create: () => Promise.reject(new Error("authenticator exploded")),
    });
    fetchMock.mockResolvedValue(
      jsonRes(200, {
        options: {
          rp: { name: "OpenSesame" },
          user: { id: "aA", name: "dev", displayName: "Dev" },
          challenge: "aGk",
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        },
      }),
    );
    await renderApp();
    await enterToken();
    await click(buttonByText("Register + assert passkey"));
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
    expect(statusText()).toBe("TOTP enrolled. Scan or copy the secret below.");
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
    expect(statusText()).toBe("TOTP enrolled. Scan or copy the secret below.");
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
    const codeLabel = [...container.querySelectorAll("label")].find((l) =>
      l.textContent?.includes("TOTP code"),
    );
    const codeInput = overlapCast(codeLabel?.querySelector("input"));
    await act(async () => {
      setInput(codeInput, "123456");
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
