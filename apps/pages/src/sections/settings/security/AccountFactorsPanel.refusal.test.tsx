/** @vitest-environment jsdom */
import { ACCOUNT_FACTOR_WORDS } from "@opensesame/app-core/lib/account-factor-words.js";
import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";
import { federationSeams } from "@opensesame/app-core/lib/federation.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import { unlockMethodsSeams } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import type { BoundaryValue } from "@opensesame/os-domain";
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
 * A refused read of the Identity account's factors, and a refused authenticator
 * seed, are failures: a mark on what failed and a notice in the tray. The card
 * never reads as though the seed were still being made.
 */

const vault = vi.hoisted(() => ({
  current: { header: { wrap: {}, kdf: {}, unlocks: {} }, guest: false },
}));
import { qrSeams } from "../../../components/QrCode.js";
import { expectInTray } from "../../../components/tray.test-support.js";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { UnlockMethodsPanel } from "../UnlockMethodsPanel.js";

const originalVaultHooks = { ...vaultHooksSeams };
const originalQr = { ...qrSeams };
const originalUnlock = { ...unlockMethodsSeams };
const originalIdentity = { ...identitySeams };
const originalDevice = { ...deviceIdentitySeams };
const originalFederation = { ...federationSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => ({}),
});
Object.assign(qrSeams, {
  QrCode: ({ value }: { value: string }) => <div data-testid="qr">{value}</div>,
});
Object.assign(unlockMethodsSeams, {
  listAvailableUnlockMethods: () => ["password"],
});

const reply = (status: number, body: BoundaryValue) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  deviceIdentitySeams.remoteIdentityApi = () => "https://id.example";
  identitySeams.currentSession = () => ({
    principalId: "prn_abcd",
    accessToken: "at",
    issuerOrigin: "https://id.example",
  });
  identitySeams.identityBase = () => "https://id.example";
  federationSeams.loadSession = () => null;
});

afterEach(() => {
  cleanup();
  Object.assign(identitySeams, originalIdentity);
  Object.assign(deviceIdentitySeams, originalDevice);
  Object.assign(federationSeams, originalFederation);
});

afterAll(() => {
  Object.assign(vaultHooksSeams, originalVaultHooks);
  Object.assign(qrSeams, originalQr);
  Object.assign(unlockMethodsSeams, originalUnlock);
});

function renderPanel() {
  return render(
    <MemoryRouter>
      <UnlockMethodsPanel />
    </MemoryRouter>,
  );
}

describe("a refused account read", () => {
  it("is a mark on the panel and a notice in the tray, not a sentence in the page", async () => {
    identitySeams.identityFetch = async () => {
      throw new Error("offline");
    };
    renderPanel();
    await screen.findByRole("region", { name: "Your account" });
    await expectInTray(ACCOUNT_FACTOR_WORDS.unreachable);
    expect(
      screen.getByRole("img", { name: ACCOUNT_FACTOR_WORDS.unreachable }),
    ).toBeTruthy();
  });
});

describe("a refused authenticator seed", () => {
  it("marks the card and trays the refusal, not 'making the seed'", async () => {
    identitySeams.identityFetch = async (path: string) =>
      path === "/v1/mfa/factors"
        ? reply(200, { ok: true, factors: [], enrollable: ["totp"] })
        : reply(503, { ok: false, error: "unavailable" });
    const user = userEvent.setup();
    renderPanel();
    const name = await screen.findByText("Account authenticator app", {
      selector: ".sw__name",
    });
    const rowEl = name.closest(".sw");
    if (!(rowEl instanceof HTMLElement)) throw new Error("no row");
    await user.click(within(rowEl).getByRole("button", { name: "Add" }));
    const notice = await waitFor(() => {
      const found = listNotices().find(
        (entry) => entry.id === "security:account-totp:begin",
      );
      if (!found) throw new Error("no notice yet");
      return found;
    });
    await expectInTray(notice.body);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("img", { name: notice.body })).toBeTruthy();
    expect(dialog.queryByText("Making the seed…")).toBeNull();
  });
});
