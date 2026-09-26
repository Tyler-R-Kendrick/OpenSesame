/** @vitest-environment jsdom */
import type { JsonObject } from "@opensesame/os-domain";
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
 * The Identity account's rows in Settings › Security (ADR 0140 D10): absent
 * without an Identity API or a session, one row and one action per factor
 * otherwise, and every ceremony in the one sheet (ADR 0091 §8).
 */

const vault = vi.hoisted(() => ({
  current: { header: { wrap: {}, kdf: {}, unlocks: {} }, guest: false },
}));
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
const originalVaultHooks = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => ({}),
});

import { qrSeams } from "../../../components/QrCode.js";
const originalQr = { ...qrSeams };
Object.assign(qrSeams, {
  QrCode: ({ value }: { value: string }) => <div data-testid="qr">{value}</div>,
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

const PK1 = `pk_${"1".repeat(28)}4f2a`;
const PK2 = `pk_${"2".repeat(28)}9c1e`;
const SESSION = {
  principalId: "prn_abcd",
  accessToken: "at",
  issuerOrigin: "https://id.example",
};

type Call = { path: string; method: string; body: string | null };

/**
 * Nothing goes on the session alone (ADR 0146): a delete carries a code or
 * an assertion over the challenge the stand-in mints.
 */
function unproved(init: RequestInit): boolean {
  return !(init.body && JSON.parse(String(init.body)).proof);
}

/** A stand-in Identity API: the factor routes, answered from memory. */
function standIn(initial: JsonObject[], enrollable = ["passkey", "totp"]) {
  let factors = [...initial];
  const calls: Call[] = [];
  const reply = (status: number, body: JsonObject) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  identitySeams.identityFetch = async (
    path: string,
    init: RequestInit = {},
  ) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body ? String(init.body) : null });
    if (path === "/v1/mfa/factors" && method === "GET") {
      return reply(200, { ok: true, factors, enrollable });
    }
    if (path.startsWith("/v1/mfa/factors/") && method === "DELETE") {
      if (unproved(init)) {
        return reply(403, { ok: false, error: "step_up_required" });
      }
      const id = decodeURIComponent(path.slice("/v1/mfa/factors/".length));
      const before = factors.length;
      factors = factors.filter((factor) => factor.id !== id);
      return before === factors.length
        ? reply(404, { ok: false, error: "not_found" })
        : reply(200, { ok: true, id });
    }
    if (path === "/v1/mfa/totp/enroll") {
      factors = [...factors, { id: "totp", kind: "totp" }];
      return reply(200, {
        ok: true,
        secret: "c2VlZA==",
        otpauthUrl:
          "otpauth://totp/OpenSesame:prn_abcd?secret=JBSWY3DPEHPK3PXP&issuer=OpenSesame",
      });
    }
    if (path === "/v1/mfa/passkey/authentication-options") {
      return reply(200, { ok: true, options: { challenge: "cmVtb3Zl" } });
    }
    if (path === "/v1/mfa/totp/verify") {
      const code = JSON.parse(String(init.body)).code;
      return code === "123456"
        ? reply(200, { ok: true })
        : reply(401, { ok: false });
    }
    return reply(404, { error: "not_found" });
  };
  return { calls, factors: () => factors };
}

/** A browser whose platform authenticator answers an assertion. */
function assertingBrowser() {
  const bytes = (n: number) => new Uint8Array([n]).buffer;
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: {
      get: async () => ({
        id: "cred-1",
        type: "public-key",
        rawId: bytes(1),
        response: {
          clientDataJSON: bytes(3),
          authenticatorData: bytes(4),
          signature: bytes(5),
        },
        getClientExtensionResults: () => ({}),
      }),
    },
  });
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
}

function row(name: string) {
  const all = screen.getAllByText(name, { selector: ".sw__name" });
  const container = all[0]?.closest(".sw");
  if (!(container instanceof HTMLElement)) throw new Error(`no row ${name}`);
  return within(container);
}

function sheet() {
  return within(screen.getByRole("dialog"));
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
  Object.assign(qrSeams, originalQr);
  Object.assign(unlockMethodsSeams, originalUnlock);
});

describe("account rows", () => {
  it("are absent, with no word about them, without an Identity API", () => {
    deviceIdentitySeams.remoteIdentityApi = () => "";
    const api = standIn([]);
    render(
      <MemoryRouter>
        <UnlockMethodsPanel />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Your account")).toBeNull();
    expect(screen.queryByText(/Account passkey/)).toBeNull();
    expect(api.calls).toEqual([]);
  });

  it("are absent while nobody is signed in", () => {
    identitySeams.currentSession = () => null;
    const api = standIn([]);
    render(
      <MemoryRouter>
        <UnlockMethodsPanel />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Your account")).toBeNull();
    expect(api.calls).toEqual([]);
  });

  it("draw one row per factor beside the vault's keys, one action each", async () => {
    standIn([
      { id: PK1, kind: "passkey", createdAt: "2026-09-20T09:00:00.000Z" },
      { id: "totp", kind: "totp" },
    ]);
    render(
      <MemoryRouter>
        <UnlockMethodsPanel />
      </MemoryRouter>,
    );
    // The vault's own list is still there.
    expect(screen.getByText("Unlock methods")).toBeTruthy();
    const panel = within(
      await screen.findByRole("region", { name: "Your account" }),
    );
    expect(
      panel.getByText(/None of these open this vault/, { exact: false }),
    ).toBeTruthy();
    await panel.findByText(/key 4f2a/);
    const passkey = row("Account passkey");
    expect(passkey.getAllByRole("button")).toHaveLength(1);
    expect(passkey.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(
      row("Another account passkey").getByRole("button", { name: "Add" }),
    ).toBeTruthy();
    expect(
      row("Account authenticator app").getByRole("button", { name: "Remove" }),
    ).toBeTruthy();
    // Never an input under a row.
    expect(panel.queryByRole("textbox")).toBeNull();
  });

  it("offers no authenticator row where the service makes none", async () => {
    standIn([], ["passkey"]);
    render(
      <MemoryRouter>
        <UnlockMethodsPanel />
      </MemoryRouter>,
    );
    await screen.findByText("Account passkey", { selector: ".sw__name" });
    expect(screen.queryByText("Account authenticator app")).toBeNull();
  });
});

describe("the one sheet", () => {
  it("removes a passkey, proved and confirmed in its card, and reads the list again", async () => {
    assertingBrowser();
    const api = standIn([
      { id: PK1, kind: "passkey", createdAt: "2026-09-20T09:00:00.000Z" },
      { id: PK2, kind: "passkey" },
    ]);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <UnlockMethodsPanel />
      </MemoryRouter>,
    );
    await screen.findByText(/key 4f2a/);
    const first = screen.getByText(/key 4f2a/).closest(".sw");
    if (!(first instanceof HTMLElement)) throw new Error("no row");
    await user.click(within(first).getByRole("button", { name: "Remove" }));
    expect(sheet().getByText("Remove this passkey?")).toBeTruthy();
    expect(sheet().getByText(/untouched; its keys keep working/)).toBeTruthy();
    await user.click(sheet().getByRole("button", { name: "Remove passkey" }));
    await user.click(await sheet().findByRole("button", { name: "Done" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const removal = api.calls.find((call) => call.method === "DELETE");
    expect(removal?.path).toBe(`/v1/mfa/factors/${PK1}`);
    expect(JSON.parse(String(removal?.body)).proof).toMatchObject({
      kind: "passkey",
      credentialId: "cred-1",
    });
    await waitFor(() => expect(screen.queryByText(/key 4f2a/)).toBeNull());
    expect(screen.getByText(/9c1e/)).toBeTruthy();
  });

  it("sets up the authenticator app: scan, then a code that matches", async () => {
    const api = standIn([]);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <UnlockMethodsPanel />
      </MemoryRouter>,
    );
    await screen.findByText("Account authenticator app", {
      selector: ".sw__name",
    });
    await user.click(
      row("Account authenticator app").getByRole("button", { name: "Add" }),
    );
    expect(await sheet().findByTestId("qr")).toBeTruthy();
    expect(sheet().getByTestId("qr").textContent).toMatch(/^otpauth:\/\/totp/);
    // The base64 seed the service also returned never reaches the page.
    expect(document.body.textContent).not.toContain("c2VlZA==");
    await user.click(sheet().getByRole("button", { name: "I scanned it" }));
    await user.type(sheet().getByLabelText("Six digits"), "123456");
    await user.click(sheet().getByRole("button", { name: "Turn on" }));
    expect(await sheet().findByText("Authenticator on")).toBeTruthy();
    await user.click(sheet().getByRole("button", { name: "Done" }));

    await waitFor(() =>
      expect(
        row("Account authenticator app").getByRole("button", {
          name: "Remove",
        }),
      ).toBeTruthy(),
    );
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toContain(
      "POST /v1/mfa/totp/verify",
    );
    expect(api.calls.some((call) => call.path === "/v1/mfa/factors/totp")).toBe(
      false,
    );
  });

  it("removes a setup closed before a code matched", async () => {
    const api = standIn([]);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <UnlockMethodsPanel />
      </MemoryRouter>,
    );
    const add = (
      await screen.findByText("Account authenticator app", {
        selector: ".sw__name",
      })
    ).closest(".sw");
    if (!(add instanceof HTMLElement)) throw new Error("no row");
    await user.click(within(add).getByRole("button", { name: "Add" }));
    await sheet().findByTestId("qr");
    await user.click(sheet().getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(api.calls.map((call) => `${call.method} ${call.path}`)).toContain(
        "DELETE /v1/mfa/factors/totp",
      ),
    );
    // The seed still in memory proves its own removal with its code now.
    const removal = api.calls.find((call) => call.method === "DELETE");
    expect(JSON.parse(String(removal?.body)).proof).toMatchObject({
      kind: "totp",
      code: expect.stringMatching(/^\d{6}$/),
    });
    expect(api.factors()).toEqual([]);
  });

  it("says a browser without passkeys cannot make one, and sends nothing", async () => {
    const api = standIn([]);
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
    expect(
      sheet().getByText("This browser cannot make a passkey"),
    ).toBeTruthy();
    expect(api.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });
});
