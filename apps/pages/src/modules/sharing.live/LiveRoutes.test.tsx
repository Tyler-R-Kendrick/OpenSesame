/** @vitest-environment jsdom */
/**
 * Routes (ADR 0150 §6) through the screens people use: the owner names an
 * address, a TURN server and a carrier in Settings › Live sessions › Routes;
 * a joiner is shown every host the link names before anything is contacted,
 * and — keeping them — pairs with no code pasted either way. The peers and
 * the carrier service are fakes (real ones: verify:live-join).
 */
import { holdLiveLink } from "@opensesame/app-core/lib/live/link.js";
import { FakeBus, FakeNet } from "@opensesame/app-core/lib/live/live-fakes.js";
import { linkRoutes } from "@opensesame/app-core/lib/live/routes.js";
import {
  currentGuest,
  currentHost,
  endHosting,
  leaveLive,
  liveSeams,
  startHosting,
} from "@opensesame/app-core/lib/live/session.js";
import {
  DIRECT_TRANSPORT,
  type LiveTransport,
} from "@opensesame/app-core/lib/live/transport.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem } from "@opensesame/vault-core";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { withPassword } from "../../sections/vault/account.test-support.js";
import { LiveJoinRoute } from "./LiveJoinRoute.js";
import { LiveRoutesPanel } from "./LiveRoutesPanel.js";
import { clearJoinDraft, liveUiSeams } from "./live-hooks.js";
import { transportSeams } from "./live-transport-hooks.js";

const github = createItem("account", "GitHub");
withPassword(github, "correct horse battery staple");

const originalHooks = { ...vaultHooksSeams };
const originalLive = { ...liveSeams };
const originalUi = { ...liveUiSeams };
const originalTransport = { ...transportSeams };
let net: FakeNet;
let bus: FakeBus;
let stored: LiveTransport;

beforeEach(() => {
  net = new FakeNet();
  bus = new FakeBus();
  stored = DIRECT_TRANSPORT;
  Object.assign(vaultHooksSeams, {
    useVault: () => ({
      ...vaultStore.getSnapshot(),
      status: "unlocked" as const,
      items: [github],
    }),
  });
  Object.assign(liveSeams, { items: () => [github] });
  Object.assign(liveUiSeams, {
    transport: net.transports(),
    carriers: bus.factory(),
  });
  Object.assign(transportSeams, {
    tomb: () => "personal",
    read: async () => stored,
    write: async (_tomb: string, next: LiveTransport) => {
      stored = next;
    },
  });
});

afterEach(() => {
  clearJoinDraft();
  leaveLive();
  endHosting();
  cleanup();
  Object.assign(vaultHooksSeams, originalHooks);
  Object.assign(liveSeams, originalLive);
  Object.assign(liveUiSeams, originalUi);
  Object.assign(transportSeams, originalTransport);
});

function type(where: ReturnType<typeof within>, label: string, value: string) {
  fireEvent.change(where.getByLabelText(label), { target: { value } });
}

describe("Settings › Live sessions › Routes", () => {
  it("adds a tailnet address, a TURN server with its credentials, and a carrier", async () => {
    const panel = within(render(<LiveRoutesPanel />).container);
    await panel.findByLabelText("Tailnet, VPN or LAN address");

    type(panel, "Tailnet, VPN or LAN address", "owner.tailnet.ts.net");
    expect(panel.getByRole("img", { name: "Not an IP address" })).toBeTruthy();
    type(panel, "Tailnet, VPN or LAN address", "100.101.102.103");
    fireEvent.click(panel.getByRole("button", { name: "Add the address" }));
    await panel.findByText("100.101.102.103");

    // Relay only means nothing until there is a TURN server: not drawn.
    expect(
      panel.queryByRole("checkbox", { name: "Relay only, through TURN" }),
    ).toBeNull();
    type(
      panel,
      "STUN or TURN server",
      "turns:turn.example.com:443?transport=tcp",
    );
    expect(
      panel.getByRole("button", { name: "Add the server" }),
    ).toHaveProperty("disabled", true);
    type(panel, "TURN username", "live");
    type(panel, "TURN credential", "s3cret");
    fireEvent.click(panel.getByRole("button", { name: "Add the server" }));
    await panel.findByText("turns:turn.example.com:443?transport=tcp");
    await waitFor(() =>
      expect(
        panel.getByRole("checkbox", { name: "Relay only, through TURN" }),
      ).toHaveProperty("disabled", false),
    );

    fireEvent.change(panel.getByLabelText("Code carrier"), {
      target: { value: "nostr" },
    });
    type(panel, "Server (wss://)", "ws://relay.example.com");
    expect(
      panel.getByRole("img", { name: "Needs a secure address" }),
    ).toBeTruthy();
    type(panel, "Server (wss://)", "wss://relay.example.com");
    fireEvent.click(panel.getByRole("button", { name: "Add the carrier" }));
    await panel.findByText("wss://relay.example.com");

    expect(stored).toEqual({
      addresses: ["100.101.102.103"],
      ice: [
        {
          urls: ["turns:turn.example.com:443?transport=tcp"],
          username: "live",
          credential: "s3cret",
        },
      ],
      relay: false,
      carriers: [{ kind: "nostr", url: "wss://relay.example.com" }],
    });

    fireEvent.click(
      panel.getByRole("button", { name: "Remove 100.101.102.103" }),
    );
    await waitFor(() => expect(stored.addresses).toEqual([]));
  });
});

async function host(transport: LiveTransport) {
  return startHosting({
    title: "Team",
    scope: { kind: "vault" },
    policy: "read",
    admission: "open",
    minutes: 30,
    transport: net.transports(),
    routes: transport,
    carriers: bus.factory(),
  });
}

function openJoin() {
  return within(
    render(
      <MemoryRouter>
        <LiveJoinRoute />
      </MemoryRouter>,
    ).container,
  );
}

const CARRIED: LiveTransport = {
  addresses: ["100.101.102.103"],
  ice: [{ urls: ["turn:turn.example.ts.net:3478"], secret: "rest-secret" }],
  relay: false,
  carriers: [{ kind: "ntfy", url: "https://ntfy.example.ts.net" }],
};

describe("joining through the owner's routes", () => {
  it("lists every host before contacting any, and pairs with nothing pasted", async () => {
    await host(CARRIED);
    const link = currentHost()?.link ?? null;
    // What the link carries, decoded: minted credentials, never the secret;
    // and never the owner's address.
    const carried = JSON.stringify(link && linkRoutes(link));
    expect(carried).toContain("turn.example.ts.net");
    expect(carried).not.toContain("rest-secret");
    expect(carried).not.toContain("100.101.102.103");
    holdLiveLink(link);
    const joiner = openJoin();
    const choice = joiner.getByRole("checkbox", {
      name: "Through turn.example.ts.net, ntfy.example.ts.net",
    });
    expect(choice).toHaveProperty("checked", true);
    const posted = bus.seen.length;
    expect(posted).toBe(0);

    type(joiner, "Your name", "Ada");
    fireEvent.click(joiner.getByRole("button", { name: "Ask to join" }));
    await joiner.findByRole("img", { name: "Joined Team" });
    expect(bus.seen.length).toBeGreaterThan(0);
    expect(currentHost()?.state.guests[0]).toMatchObject({
      name: "Ada",
      state: "joined",
    });
  });

  it("the person keeps to a direct route: no carrier hears of them", async () => {
    await host(CARRIED);
    holdLiveLink(currentHost()?.link ?? null);
    const joiner = openJoin();
    fireEvent.click(joiner.getByRole("checkbox", { name: /^Through / }));
    type(joiner, "Your name", "Ada");
    fireEvent.click(joiner.getByRole("button", { name: "Ask to join" }));
    await joiner.findByRole("button", { name: "Copy your request code" });
    expect(bus.seen).toEqual([]);
    expect(currentGuest()?.status.at).toBe("request");
    expect(currentHost()?.state.guests).toEqual([]);
  });
});
