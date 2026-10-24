/** @vitest-environment jsdom */
/**
 * The Authorize sheet must never hang on "Reading CLI request…" or claim no
 * request is waiting when it could not check: on a shared-origin deployment
 * (GitHub Pages) the local-network fence throws, and a daemon that refuses
 * or cannot be read is an error, not an empty queue (#1193).
 */
import {
  CLI_APP_INTEGRATION_BEARER_KEY,
  clearCliAppIntegrationBearer,
  writeCliAppIntegrationBearer,
} from "@opensesame/app-core/lib/cli-app-integration/bearer-session.js";
import * as pairing from "@opensesame/app-core/lib/cli-app-integration/pairing.js";
import {
  clearCliAppWebAuthnCredential,
  saveCliAppWebAuthnCredential,
} from "@opensesame/app-core/lib/cli-app-integration/webauthn-credential.js";
import { localNetworkFetchSeams } from "@opensesame/app-core/lib/local-network-fetch.js";
import { ownsWebStorageKey } from "@opensesame/app-core/lib/storage-ownership.js";
import { takeStorageWrites } from "@opensesame/app-core/test-host-storage-writes.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectInTray } from "../../components/tray.test-support.js";
import {
  CLI_AUTHORIZE_LOAD_BLOCKED,
  CLI_AUTHORIZE_LOAD_UNREADABLE,
  CLI_AUTHORIZE_PASSKEY_MISSING,
  CLI_AUTHORIZE_PASSKEY_NAME,
  CLI_AUTHORIZE_PASSKEY_UNSUPPORTED,
} from "./cli-authorize-messages.js";
import { CliAuthorizePanel } from "./cli-authorize-panel.js";

const BLOCKED = CLI_AUTHORIZE_LOAD_BLOCKED;
const UNREADABLE = CLI_AUTHORIZE_LOAD_UNREADABLE;
const EMPTY = "No CLI request is waiting.";
const LOADING = "Reading CLI request…";
const eligible = localNetworkFetchSeams.eligible;

function showPaired() {
  writeCliAppIntegrationBearer("A".repeat(43));
  return render(<CliAuthorizePanel />);
}

function pendingResponse() {
  return new Response(
    JSON.stringify({
      pending: [
        {
          requestId: "req",
          terminalSessionId: "term",
          verb: "vault list",
          respondNonce: "nonce",
        },
      ],
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function allowPasskeyApi() {
  vi.stubGlobal("PublicKeyCredential", class PublicKeyCredential {});
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: { create: vi.fn(), get: vi.fn() },
  });
}

afterEach(async () => {
  cleanup();
  clearCliAppIntegrationBearer();
  await clearCliAppWebAuthnCredential();
  localNetworkFetchSeams.eligible = eligible;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Authorize CLI pending check", () => {
  it("hides the pairing field on a shared origin and explains the block in the tray", async () => {
    render(<CliAuthorizePanel />);
    expect(await screen.findByRole("img", { name: BLOCKED })).toBeTruthy();
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Pair with the daemon" }),
    ).toBeNull();
    await expectInTray(BLOCKED);
    expect(BLOCKED).toMatch(/optional/i);
    expect(BLOCKED).toMatch(/own deployment/i);
    expect(BLOCKED).toMatch(/passkey/i);
    expect(BLOCKED).toMatch(/blocked on this site/i);
  });

  it("keeps the pair control visible but disabled until a code is entered", async () => {
    localNetworkFetchSeams.eligible = () => true;
    render(<CliAuthorizePanel />);
    const pair = await screen.findByRole("button", {
      name: "Pair with the daemon",
    });
    expect(pair.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("img", { name: BLOCKED })).toBeNull();
  });

  it("shows Finish pairing beside the key", async () => {
    localNetworkFetchSeams.eligible = () => true;
    vi.spyOn(pairing, "parseCliAppPairingCode").mockReturnValue({
      code: "A".repeat(43),
      origin: "http://localhost:5180",
      url: "http://127.0.0.1:18790",
      label: "CLI",
    });
    vi.spyOn(pairing, "confirmCliAppPairingCode").mockResolvedValue({
      ok: true,
      registrationCode: "123456",
    });
    render(<CliAuthorizePanel />);
    fireEvent.change(await screen.findByLabelText("Pairing code"), {
      target: { value: "opensesame-cli-app:v1:test" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Pair with the daemon" }),
    );
    expect(
      await screen.findByRole("button", { name: "Finish pairing" }),
    ).toBeTruthy();
    expect(document.querySelector(".go-verb")?.textContent).toBe(
      "Finish pairing",
    );
  });

  describe("paired daemon check", () => {
    afterEach(() => {
      // Pairing writes the CLI bearer under a key the storage-ownership
      // registry does not own yet (it predates this suite). Drain the recorded
      // writes so the setup's ownership assert judges only new keys, and pin
      // the known gap so any other unowned write still fails here.
      const unowned = takeStorageWrites().filter(
        (write) => !ownsWebStorageKey(write.key, write.area),
      );
      expect(unowned).toEqual([
        { area: "session", key: CLI_APP_INTEGRATION_BEARER_KEY },
      ]);
    });

    it("explains that local approval is blocked on this site instead of hanging or claiming an empty queue", async () => {
      // The test host stamps the shared-origin (GitHub Pages) profile, so the
      // real fence in localNetworkFetch throws before any fetch is attempted.
      showPaired();
      expect(await screen.findByRole("img", { name: BLOCKED })).toBeTruthy();
      expect(screen.queryByText(LOADING)).toBeNull();
      expect(screen.queryByText(EMPTY)).toBeNull();
      await expectInTray(BLOCKED);
    });

    it("says the check failed when the daemon refuses, not that no request is waiting", async () => {
      localNetworkFetchSeams.eligible = () => true;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("no", { status: 401 })),
      );
      showPaired();
      expect(await screen.findByRole("img", { name: UNREADABLE })).toBeTruthy();
      expect(screen.queryByText(EMPTY)).toBeNull();
      await expectInTray(UNREADABLE);
    });

    it("names the passkey approval when a request is waiting", async () => {
      localNetworkFetchSeams.eligible = () => true;
      allowPasskeyApi();
      await saveCliAppWebAuthnCredential({
        credentialIdB64: "cred",
        coseKeyB64: "cose",
        publicKeySpkiB64: "spki",
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => pendingResponse()),
      );
      showPaired();
      expect(
        await screen.findByRole("button", { name: CLI_AUTHORIZE_PASSKEY_NAME }),
      ).toBeTruthy();
    });

    it("does not offer approval when no passkey is stored", async () => {
      localNetworkFetchSeams.eligible = () => true;
      allowPasskeyApi();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => pendingResponse()),
      );
      showPaired();
      expect(
        await screen.findByRole("img", { name: CLI_AUTHORIZE_PASSKEY_MISSING }),
      ).toBeTruthy();
      await expectInTray(CLI_AUTHORIZE_PASSKEY_MISSING);
      expect(
        screen.queryByRole("button", { name: CLI_AUTHORIZE_PASSKEY_NAME }),
      ).toBeNull();
      expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
    });

    it("does not offer approval when this browser cannot use a passkey", async () => {
      localNetworkFetchSeams.eligible = () => true;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => pendingResponse()),
      );
      showPaired();
      expect(
        await screen.findByRole("img", {
          name: CLI_AUTHORIZE_PASSKEY_UNSUPPORTED,
        }),
      ).toBeTruthy();
      await expectInTray(CLI_AUTHORIZE_PASSKEY_UNSUPPORTED);
      expect(
        screen.queryByRole("button", { name: CLI_AUTHORIZE_PASSKEY_NAME }),
      ).toBeNull();
      expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
    });

    it("keeps the request when the proof is rejected", async () => {
      localNetworkFetchSeams.eligible = () => true;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          if (String(input).includes("/respond")) {
            return new Response(JSON.stringify({ status: "wrongSession" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return pendingResponse();
        }),
      );
      showPaired();
      fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
      expect(
        await screen.findByRole("img", {
          name: "The passkey proof was rejected.",
        }),
      ).toBeTruthy();
      expect(screen.getByText("vault list")).toBeTruthy();
    });

    it("still says no request is waiting when the daemon answers with an empty queue", async () => {
      localNetworkFetchSeams.eligible = () => true;
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ pending: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        ),
      );
      showPaired();
      expect(await screen.findByText(EMPTY)).toBeTruthy();
      expect(screen.queryByText(BLOCKED)).toBeNull();
      expect(screen.queryByText(UNREADABLE)).toBeNull();
    });
  });
});
