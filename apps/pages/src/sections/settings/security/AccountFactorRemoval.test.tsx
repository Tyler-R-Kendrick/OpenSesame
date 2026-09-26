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
 * Removing one of the account's factors asks for a step-up first (ADR 0146):
 * the sheet gathers a proof from one of the account's own factors, sends it
 * on the delete, and a refused proof leaves the person signed in, the sheet
 * open and the keyboard where the next try starts. The Security list itself
 * stays one row and one action per factor, never an input (ADR 0091).
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
const GOOD = "246810";
const SESSION = {
  principalId: "prn_abcd",
  accessToken: "at",
  issuerOrigin: "https://id.example",
};

type Call = { path: string; method: string; body: JsonObject | null };

const reply = (status: number, body: JsonObject) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * A stand-in Identity API that asks for a step-up the way the real one does:
 * no proof is 403 `step_up_required`, a wrong one 403 `step_up_failed`, and
 * only a 401 would mean the session ended — which this one never sends.
 */
function standIn(initial: JsonObject[]) {
  let factors = [...initial];
  const calls: Call[] = [];
  identitySeams.identityFetch = async (
    path: string,
    init: RequestInit = {},
  ) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, method, body });
    if (path === "/v1/mfa/factors" && method === "GET") {
      return reply(200, { ok: true, factors, enrollable: ["passkey", "totp"] });
    }
    if (path === "/v1/mfa/passkey/authentication-options") {
      return reply(200, { ok: true, options: { challenge: "cmVtb3Zl" } });
    }
    if (path.startsWith("/v1/mfa/factors/") && method === "DELETE") {
      const proof = body?.proof;
      if (!proof) return reply(403, { ok: false, error: "step_up_required" });
      const good =
        (proof.kind === "totp" && proof.code === GOOD) ||
        (proof.kind === "passkey" && proof.credentialId === "cred-1");
      if (!good) return reply(403, { ok: false, error: "step_up_failed" });
      const id = decodeURIComponent(path.slice("/v1/mfa/factors/".length));
      factors = factors.filter((factor) => factor.id !== id);
      return reply(200, { ok: true, id });
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

function sheet() {
  return within(screen.getByRole("dialog"));
}

/** The removed card: an ok mark in a live region, the keyboard on Done. */
async function doneCard(label: string) {
  const mark = await sheet().findByRole("img", { name: label });
  expect(mark.className).toContain("status-mark--ok");
  expect(mark.closest("output")?.getAttribute("aria-live")).toBe("polite");
  const done = sheet().getByRole("button", { name: "Done" });
  await waitFor(() => expect(document.activeElement).toBe(done));
  expect(document.querySelector(".note, .conn-flash")).toBeNull();
  return done;
}

async function openRemoval(tail: RegExp) {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <UnlockMethodsPanel />
    </MemoryRouter>,
  );
  const label = await screen.findByText(tail);
  const row = label.closest(".sw");
  if (!(row instanceof HTMLElement)) throw new Error("no row");
  await user.click(within(row).getByRole("button", { name: "Remove" }));
  return user;
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

describe("removing an account factor asks for a proof", () => {
  it("proves with a passkey, sends it on the delete, and lands focus on what is left", async () => {
    assertingBrowser();
    const api = standIn([
      { id: PK1, kind: "passkey", createdAt: "2026-09-20T09:00:00.000Z" },
      { id: PK2, kind: "passkey" },
    ]);
    const user = await openRemoval(/key 4f2a/);
    // One kind on the account: no choice to make, and the proof is named.
    expect(sheet().queryByRole("group", { name: "Prove it is you with" })).toBe(
      null,
    );
    expect(sheet().getByText("a passkey on your account")).toBeTruthy();
    await user.click(sheet().getByRole("button", { name: "Remove passkey" }));

    // The outcome is a mark in the card's live region, and the keyboard is
    // on Done — the key that pressed Remove is gone.
    const done = await doneCard("Account passkey removed.");
    await user.keyboard("{Enter}");
    expect(done.isConnected).toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const [options, removal] = api.calls.filter(
      (call) => call.method !== "GET",
    );
    expect(options).toMatchObject({
      path: "/v1/mfa/passkey/authentication-options",
      body: { purpose: "factor.remove", factorId: PK1 },
    });
    expect(removal).toMatchObject({
      path: `/v1/mfa/factors/${PK1}`,
      method: "DELETE",
      body: { proof: { kind: "passkey", credentialId: "cred-1" } },
    });
    await waitFor(() => expect(screen.queryByText(/key 4f2a/)).toBeNull());
    // The row that opened the sheet is gone; the keyboard is not on the page.
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    const panel = screen.getByRole("region", { name: "Your account" });
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it("lets the person choose, and keeps them signed in when a code is refused", async () => {
    assertingBrowser();
    const api = standIn([
      { id: PK1, kind: "passkey", createdAt: "2026-09-20T09:00:00.000Z" },
      { id: "totp", kind: "totp" },
    ]);
    const user = await openRemoval(/key 4f2a/);
    const choice = sheet().getByRole("group", { name: "Prove it is you with" });
    const passkey = within(choice).getByRole("button", { name: "Passkey" });
    const code = within(choice).getByRole("button", {
      name: "Authenticator code",
    });
    expect(passkey.getAttribute("aria-pressed")).toBe("true");
    expect(sheet().queryByLabelText("Six digits")).toBeNull();

    await user.click(code);
    expect(code.getAttribute("aria-pressed")).toBe("true");
    const field = await sheet().findByLabelText("Six digits");
    await waitFor(() => expect(document.activeElement).toBe(field));
    const remove = sheet().getByRole("button", { name: "Remove passkey" });
    expect(remove.hasAttribute("disabled")).toBe(true);

    await user.type(field, "111111");
    await user.click(remove);
    // Refused: a mark in the live region, the sheet still open, the field
    // cleared and focused for the next code — and nobody signed out.
    const mark = await sheet().findByRole("img", {
      name: /did not accept that proof/,
    });
    expect(mark.className).toContain("status-mark--err");
    expect(mark.closest("output")?.getAttribute("aria-live")).toBe("polite");
    expect(document.querySelector(".note, .conn-flash")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(sheet().getByLabelText("Six digits")),
    );
    expect(
      (sheet().getByLabelText("Six digits") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.getByRole("region", { name: "Your account" })).toBeTruthy();
    expect(screen.queryByText(/session ended/i)).toBeNull();

    await user.type(sheet().getByLabelText("Six digits"), GOOD);
    await user.click(sheet().getByRole("button", { name: "Remove passkey" }));
    await doneCard("Account passkey removed.");
    await user.click(sheet().getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const deletes = api.calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.body)).toEqual([
      { proof: { kind: "totp", code: "111111" } },
      { proof: { kind: "totp", code: GOOD } },
    ]);
    expect(api.factors().map((factor) => factor.id)).toEqual(["totp"]);
  });

  it("is reached and left by the keyboard alone, and the list stays read-only", async () => {
    standIn([{ id: "totp", kind: "totp" }]);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <UnlockMethodsPanel />
      </MemoryRouter>,
    );
    const panel = await screen.findByRole("region", { name: "Your account" });
    const remove = await within(panel).findByRole("button", { name: "Remove" });
    expect(within(panel).queryByRole("textbox")).toBeNull();
    remove.focus();
    await user.keyboard("{Enter}");
    // The sheet opens on its Close key; Tab walks the field, the danger key
    // and Keep it, and stays inside the sheet.
    const close = sheet().getByRole("button", { name: "Close" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    await user.tab();
    expect(document.activeElement).toBe(sheet().getByLabelText("Six digits"));
    await user.keyboard(GOOD);
    await user.tab();
    expect(document.activeElement).toBe(
      sheet().getByRole("button", { name: "Remove authenticator" }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      sheet().getByRole("button", { name: "Keep it" }),
    );
    // Only the open sheet holds focus: Tab wraps to its Close key.
    await user.tab();
    expect(document.activeElement).toBe(close);
    // Enter in the field submits the proof; Enter on Done leaves the sheet.
    await user.tab();
    await user.keyboard("{Enter}");
    await doneCard("Account authenticator app removed.");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(panel.contains(document.activeElement)).toBe(true),
    );
  });

  it("says a browser without passkeys cannot prove a passkey-only account, and sends nothing", async () => {
    const api = standIn([
      { id: PK1, kind: "passkey", createdAt: "2026-09-20T09:00:00.000Z" },
    ]);
    const user = await openRemoval(/key 4f2a/);
    expect(sheet().getByText("This browser cannot use a passkey")).toBeTruthy();
    expect(
      sheet().queryByRole("button", { name: "Remove passkey" }),
    ).toBeNull();
    await user.click(sheet().getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });
});
