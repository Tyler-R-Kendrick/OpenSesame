/** @vitest-environment jsdom */
import { ACCOUNT_PASSKEY_UNCHECKED_WORDS } from "@opensesame/app-core/lib/account-factors.js";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Adding an account passkey in Settings › Security tries it once (ADR 0140
 * plan step 11c). Accepted, the sheet closes as before; not tried to the
 * end, the passkey stays saved and the card says so with a warn mark and a
 * live region, steering away from a second passkey — never a note box.
 */

const vault = {
  current: { header: { wrap: {}, kdf: {}, unlocks: {} }, guest: false },
};
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
const originalVaultHooks = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => ({}),
});

import { unlockMethodsSeams } from "@opensesame/app-core/lib/vault/unlock-methods.js";
const originalUnlock = { ...unlockMethodsSeams };
Object.assign(unlockMethodsSeams, {
  listAvailableUnlockMethods: () => ["password"],
});

import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";
import { federationSeams } from "@opensesame/app-core/lib/federation.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
const originalIdentity = { ...identitySeams };
const originalDevice = { ...deviceIdentitySeams };
const originalFederation = { ...federationSeams };

import { UnlockMethodsPanel } from "../UnlockMethodsPanel.js";

const SESSION = {
  principalId: "prn_abcd",
  accessToken: "at",
  issuerOrigin: "https://id.example",
};

const PK = `pk_${"1".repeat(28)}4f2a`;

type Call = { plane: "session" | "anonymous"; path: string };

const reply = (status: number, body: JsonObject) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const CREATION = {
  rp: { name: "OpenSesame", id: "localhost" },
  user: { id: "dXNlcg", name: "prn_abcd", displayName: "prn_abcd" },
  challenge: "Y2hhbGxlbmdl",
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
};

/**
 * A stand-in Identity API for the passkey routes: the session plane is
 * `identityFetch`, and the anonymous assertion arrives through `fetch` with
 * no bearer. `options` answers the request-options call, `assert` the
 * assertion.
 */
interface StandInAnswers {
  /** The request-options call's answer. */
  options(): Response;
  /** The anonymous assertion's answer. */
  assert(): Response;
}

function standIn(answers: StandInAnswers) {
  let factors: JsonObject[] = [];
  const calls: Call[] = [];
  identitySeams.identityFetch = async (
    path: string,
    init: RequestInit = {},
  ) => {
    const method = init.method ?? "GET";
    calls.push({ plane: "session", path });
    if (path === "/v1/mfa/factors" && method === "GET") {
      return reply(200, { ok: true, factors, enrollable: ["passkey"] });
    }
    if (path === "/v1/mfa/passkey/registration-options") {
      return reply(200, { ok: true, options: CREATION });
    }
    if (path === "/v1/mfa/passkey/register") {
      factors = [...factors, { id: PK, kind: "passkey" }];
      return reply(200, { ok: true, principalId: "prn_abcd" });
    }
    if (path === "/v1/mfa/passkey/authentication-options") {
      return answers.options();
    }
    return reply(404, { error: "not_found" });
  };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    calls.push({ plane: "anonymous", path: url.pathname });
    expect(new Headers(init.headers).get("authorization")).toBeNull();
    expect(init.credentials).toBe("omit");
    return answers.assert();
  });
  return { calls };
}

/** An authenticator's response as `sdk-browser` reads it: buffers. */
interface ResponseBuffers {
  clientDataJSON: ArrayBuffer;
  attestationObject?: ArrayBuffer;
  authenticatorData?: ArrayBuffer;
  signature?: ArrayBuffer;
}

/** Credentials as `sdk-browser` reads them: buffers, not base64. */
function credential(response: ResponseBuffers): Credential {
  return overlapCast({
    id: "cred-1",
    type: "public-key",
    rawId: new Uint8Array([1]).buffer,
    response,
    getClientExtensionResults: () => ({}),
  });
}

/** The browser's platform authenticator; `get` is the passkey's first try. */
function browser(get: () => Promise<Credential | null>) {
  const bytes = (n: number) => new Uint8Array([n]).buffer;
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: {
      create: async () =>
        credential({ clientDataJSON: bytes(1), attestationObject: bytes(2) }),
      get,
    },
  });
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
}

const accepted = () =>
  browser(async () =>
    credential({
      clientDataJSON: new Uint8Array([3]).buffer,
      authenticatorData: new Uint8Array([4]).buffer,
      signature: new Uint8Array([5]).buffer,
    }),
  );

async function createPasskey() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <UnlockMethodsPanel />
    </MemoryRouter>,
  );
  const add = (
    await screen.findByText("Account passkey", { selector: ".sw__name" })
  ).closest(".sw");
  if (!(add instanceof HTMLElement)) throw new Error("no row");
  await user.click(within(add).getByRole("button", { name: "Add" }));
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Create passkey",
    }),
  );
  return user;
}

/** The card's mark: a warn glyph in a live region, its sentence the label. */
async function warnMark() {
  const dialog = within(await screen.findByRole("dialog"));
  const mark = await dialog.findByRole("img");
  expect(mark.className).toContain("status-mark--warn");
  expect(mark.closest("output")?.getAttribute("aria-live")).toBe("polite");
  return { dialog, label: mark.getAttribute("aria-label") };
}

beforeEach(() => {
  deviceIdentitySeams.remoteIdentityApi = () => "https://id.example";
  identitySeams.currentSession = () => SESSION;
  identitySeams.identityBase = () => "https://id.example";
  federationSeams.loadSession = () => null;
});

afterEach(() => {
  cleanup();
  Object.assign(identitySeams, originalIdentity);
  Object.assign(deviceIdentitySeams, originalDevice);
  Object.assign(federationSeams, originalFederation);
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "credentials");
});

afterAll(() => {
  Object.assign(vaultHooksSeams, originalVaultHooks);
  Object.assign(unlockMethodsSeams, originalUnlock);
});

describe("adding an account passkey tries it once", () => {
  it("closes the sheet once the service accepts the try", async () => {
    const api = standIn({
      options: () => reply(200, { ok: true, options: { challenge: "YQ" } }),
      assert: () => reply(200, { ok: true }),
    });
    accepted();
    await createPasskey();

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.calls.map((call) => `${call.plane} ${call.path}`)).toEqual(
      expect.arrayContaining([
        "session /v1/mfa/passkey/register",
        "session /v1/mfa/passkey/authentication-options",
        "anonymous /v1/mfa/passkey/assert",
      ]),
    );
    expect(await screen.findByText(/[Kk]ey 4f2a/)).toBeTruthy();
    expect(document.querySelector(".status-mark--warn")).toBeNull();
  });

  it("keeps a passkey whose try could not start, and says keep it", async () => {
    const api = standIn({
      options: () => reply(500, {}),
      assert: () => reply(200, { ok: true }),
    });
    accepted();
    const user = await createPasskey();

    const { dialog, label } = await warnMark();
    expect(label).toBe(ACCOUNT_PASSKEY_UNCHECKED_WORDS.assert_failed);
    expect(dialog.getByText("keep it; do not add another")).toBeTruthy();
    // No note box for it, and nothing rolled back.
    expect(document.querySelector(".note--warn, .note--err")).toBeNull();
    expect(
      api.calls.some((call) => call.path.startsWith("/v1/mfa/factors/")),
    ).toBe(false);
    // The key that pressed Create is gone; the keyboard is on Done.
    const done = dialog.getByRole("button", { name: "Done" });
    await waitFor(() => expect(document.activeElement).toBe(done));
    await user.click(done);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(/[Kk]ey 4f2a/)).toBeTruthy();
  });

  it("keeps a passkey whose try was dismissed", async () => {
    const api = standIn({
      options: () => reply(200, { ok: true, options: { challenge: "YQ" } }),
      assert: () => reply(200, { ok: true }),
    });
    browser(async () => {
      throw new DOMException("dismissed", "NotAllowedError");
    });
    await createPasskey();

    const { label } = await warnMark();
    expect(label).toBe(ACCOUNT_PASSKEY_UNCHECKED_WORDS.cancelled);
    expect(api.calls.map((call) => call.path)).not.toContain(
      "/v1/mfa/passkey/assert",
    );
  });

  it("says a refused try is still saved, and the session is kept", async () => {
    const api = standIn({
      options: () => reply(200, { ok: true, options: { challenge: "YQ" } }),
      assert: () => reply(401, { ok: false }),
    });
    accepted();
    await createPasskey();

    const { dialog, label } = await warnMark();
    expect(label).toBe(ACCOUNT_PASSKEY_UNCHECKED_WORDS.assert_refused);
    expect(dialog.getByText("remove it here, not add another")).toBeTruthy();
    // The 401 came back on the anonymous plane, never the session's.
    expect(
      api.calls.filter((call) => call.path === "/v1/mfa/passkey/assert"),
    ).toEqual([{ plane: "anonymous", path: "/v1/mfa/passkey/assert" }]);
  });
});
