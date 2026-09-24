import type { JoinOffer } from "@opensesame/app-core/lib/join/wire.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { expect, vi } from "vitest";
import { JoinScreen, joinScreenDependencies } from "../JoinScreen.js";
import { joinCeremonyDependencies } from "./useJoinCeremony.js";

/**
 * The join ceremony's test harness (ADR 0136): an endpoint that answers at
 * once, a tab stash and a device marker held in memory, and the walk up the
 * ladder every suite shares.
 */

export const TOKEN = `osc_dlg_dlgo_${"a".repeat(32)}.${"B".repeat(43)}`;
export const OTHER = `osc_dlg_dlgo_${"c".repeat(32)}.${"D".repeat(43)}`;
export const ENDPOINT = "https://vault.example.org";
export const CODE = "BCDF-GHJK";
const original = { ...joinCeremonyDependencies };
const originalScreen = { ...joinScreenDependencies };

export const OFFER: JoinOffer = {
  id: "dlgo_1",
  manifestDigest: "sha256:ab",
  expiresAt: Date.now() + 10 * 60_000,
  items: [
    {
      id: "req",
      displayName: "GitHub · acme",
      providerId: "github",
      actions: { shown: ["read"], more: 3 },
      resources: { shown: ["repo:acme/app"], more: 0 },
      lifetime: 3600,
      required: true,
      dependencies: [],
    },
    {
      id: "opt",
      displayName: "Slack · #ops",
      providerId: "slack",
      actions: { shown: ["post"], more: 0 },
      resources: { shown: [], more: 0 },
      lifetime: null,
      required: false,
      dependencies: [],
    },
  ],
};

export const OPTIONAL_ONLY: JoinOffer = {
  ...OFFER,
  items: OFFER.items.filter((item) => !item.required),
};

/** The tab's stash and the device's marker, as the ceremony sees them. */
type Store = {
  stash: ReturnType<typeof original.readPendingJoin>;
  marked: Set<string>;
};
function emptyStore(): Store {
  return { stash: null, marked: new Set<string>() };
}
export const store = emptyStore();
export const fakes = {
  presentInvite: vi.fn<typeof original.presentInvite>(async () => OFFER),
  beginApproval: vi.fn<typeof original.beginApproval>(async () => ({
    pairingId: "p1",
    userCode: "WXYZ-1234",
    verificationUri: `${ENDPOINT}/pair`,
    expiresAt: Date.now() + 60_000,
    interval: 0,
  })),
  pollApproval: vi.fn<typeof original.pollApproval>(async () => true),
  verifyAt: vi.fn<typeof original.verifyAt>(async () => undefined),
  claimInvite: vi.fn<typeof original.claimInvite>(async () => 1),
  listOpenSessions: vi.fn<typeof original.listOpenSessions>(async () => [
    { id: "session:1", displayName: "Design review", admitsOnAsk: false },
    { id: "session:2", displayName: "Lobby", admitsOnAsk: true },
  ]),
  askToJoin: vi.fn<typeof original.askToJoin>(async () => ({
    id: "r1",
    decision: "pending" as const,
    mode: null,
  })),
  endJoinAuthority: vi.fn(),
  keepJoinAuthority: vi.fn<typeof original.keepJoinAuthority>(
    async () => undefined,
  ),
  completeSetup: vi.fn<typeof original.completeSetup>(async () => undefined),
};

export function installFakes(): void {
  store.stash = null;
  store.marked.clear();
  for (const fake of Object.values(fakes)) fake.mockClear();
  fakes.pollApproval.mockImplementation(async () => true);
  fakes.presentInvite.mockImplementation(async () => OFFER);
  Object.assign(joinCeremonyDependencies, fakes, {
    joinAvailable: () => true,
    configuredEndpoint: () => ENDPOINT,
    readPendingJoin: () => store.stash,
    writePendingJoin: (next: typeof store.stash) => {
      store.stash = next;
    },
    clearPendingJoin: () => {
      store.stash = null;
    },
    wasPresented: async (token: string) => store.marked.has(token),
    markPresented: async (token: string) => {
      store.marked.add(token);
    },
    forgetPresented: async (token: string) => {
      store.marked.delete(token);
    },
    loadSetup: () => null,
  });
  joinScreenDependencies.currentSession = () => null;
}

export function restoreFakes(): void {
  cleanup();
  Object.assign(joinCeremonyDependencies, original);
  Object.assign(joinScreenDependencies, originalScreen);
}

export function go(): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(".go");
  if (!found) throw new Error("the ceremony has no commit");
  return found;
}

export function renderInvite(onDone = () => {}) {
  render(
    <JoinScreen
      captured={{ kind: "invite", invite: { token: TOKEN, endpoint: null } }}
      configured={ENDPOINT}
      onDone={onDone}
    />,
  );
}

export function typeCode(value = CODE) {
  fireEvent.change(screen.getByLabelText("Code"), { target: { value } });
}

/** Where → approval (the operator approves at once) → verify → the offer. */
export async function approveAndVerify(endpoint = ENDPOINT) {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Ask for approval" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Verify with a passkey" }),
  );
  await screen.findByRole("heading", { name: "What you would get" });
  expect(fakes.verifyAt.mock.calls.at(-1)?.[0]).toBe(endpoint);
}

export async function lookUp() {
  fireEvent.click(screen.getByRole("button", { name: "Look up the invite" }));
  await screen.findByRole("checkbox", { name: /GitHub/ });
}
