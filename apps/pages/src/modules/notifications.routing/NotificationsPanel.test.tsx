import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";
import type { IdentitySession } from "@opensesame/app-core/lib/identity.js";
/** @vitest-environment jsdom */
/**
 * Settings › Notifications (ADR 0084; ADR 0140 D9): the Form draws the
 * routing session, every key writes through it, the file viewer's writes
 * meet the same refusals, and no preference — from a key or a file — admits
 * a channel policy refused or says what it takes to approve.
 */
import { ASSURANCE_NOTE } from "@opensesame/app-core/lib/notification-routing/channels.js";
import { ROUTING_FILE } from "@opensesame/app-core/sections/settings/notification-routing-files.js";
import { overlapCast } from "@opensesame/os-domain";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityHookSeams } from "../../bindings/identity.js";
import { useOnlineSeams } from "../../lib/use-online.js";
import { SettingsFileContext } from "../../sections/settings/files/context.js";
import { NotificationsPanel } from "./NotificationsPanel.js";
import { routingServer } from "./routing-server.test-support.js";
import { type RoutingSession, createRoutingSession } from "./session.js";

/** The Identity session the hooks report, swapped per test. */
type HeldSession = { current: IdentitySession | null };

const identity: HeldSession = { current: null };
const connect = vi.fn();
const openFile = vi.fn();
const originalRemote = deviceIdentitySeams.remoteIdentityApi;
let remote = "https://id.example";
let server = routingServer();
let session: RoutingSession;

Object.assign(identityHookSeams, {
  useConnect: () => ({ connect, connecting: false, error: null }),
  useIdentitySession: () => identity.current,
});
Object.assign(useOnlineSeams, { useOnline: () => true });

function show() {
  session = createRoutingSession(
    () => (remote && identity.current ? "prn_1" : null),
    server.transport,
  );
  return render(
    <SettingsFileContext.Provider value={{ openFile }}>
      <NotificationsPanel session={session} />
    </SettingsFileContext.Provider>,
  );
}

function panel(name: string | RegExp) {
  const heading = screen.getByRole("heading", { name });
  const section = heading.closest("section");
  if (!section) throw new Error("no panel");
  return within(section);
}

async function loaded() {
  await screen.findByRole("heading", { name: "Destinations" });
}

beforeEach(() => {
  remote = "https://id.example";
  deviceIdentitySeams.remoteIdentityApi = () => remote;
  identity.current = overlapCast({ accessToken: "t", issuerOrigin: "x" });
  server = routingServer();
});

afterEach(() => {
  cleanup();
  session.dispose();
  deviceIdentitySeams.remoteIdentityApi = originalRemote;
  connect.mockReset();
  openFile.mockReset();
});

describe("Settings › Notifications — gating (ADR 0090)", () => {
  it("with no Identity API shows the inbox alone, names no service, and asks nothing", async () => {
    remote = "";
    const { container } = show();
    expect(screen.getByText("OpenSesame inbox")).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Always in the route" }),
    ).toBeTruthy();
    expect(container.textContent).not.toMatch(/identity|sign-in service|api/i);
    await Promise.resolve();
    expect(server.fetch).not.toHaveBeenCalled();
    expect(session.files.list()).toEqual([]);
  });

  it("with no Identity session asks to connect, and reads nothing", async () => {
    identity.current = null;
    show();
    expect(
      await screen.findByRole("img", {
        name: "Sign in to choose where you hear about requests.",
      }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(connect).toHaveBeenCalledOnce();
    expect(server.fetch).not.toHaveBeenCalled();
  });
});

describe("Settings › Notifications — the Form", () => {
  it("draws channels, destinations and every class, with ADR 0084's sentence", async () => {
    show();
    await loaded();
    expect(screen.getByText(ASSURANCE_NOTE)).toBeTruthy();
    const channels = panel("Channels");
    expect(channels.getAllByRole("img", { name: "Set up here" })).toHaveLength(
      3,
    );
    expect(channels.getByRole("img", { name: "Not set up here" })).toBeTruthy();
    // Telegram binds a destination and has an adapter; Slack has none.
    expect(
      channels.getByRole("button", { name: "Connect Telegram" }),
    ).toBeTruthy();
    expect(
      channels.queryByRole("button", { name: "Connect Slack" }),
    ).toBeNull();
    const destinations = panel("Destinations");
    expect(destinations.getByText("Telegram · Personal phone")).toBeTruthy();
    expect(document.body.textContent).not.toContain("tg-77771111");
    for (const name of [
      "Someone asks to use your authority",
      "A request you sent gets decided",
      "Something security-relevant happens",
    ]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    }
  });

  it("opens the file each panel is drawn from", async () => {
    show();
    await loaded();
    await userEvent.click(
      panel("Someone asks to use your authority").getByRole("button", {
        name: "Open routing.json",
      }),
    );
    expect(openFile).toHaveBeenCalledWith(ROUTING_FILE);
  });

  it("reorders with a key, saves, and keeps the focus on the row it moved", async () => {
    show();
    await loaded();
    const requests = panel("Someone asks to use your authority");
    const later = requests.getByRole("button", {
      name: "Move Telegram later for Someone asks to use your authority",
    });
    later.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(server.byClass.get("authorization_request")?.channels).toEqual([
        "in_app",
        "telegram",
      ]),
    );
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Move Telegram earlier for Someone asks to use your authority",
      ),
    );
    expect(
      await requests.findByRole("img", { name: "Order saved." }),
    ).toBeTruthy();
  });
});

describe("Settings › Notifications — preferences only narrow (ADR 0084)", () => {
  it("never offers a channel policy refused for the class", async () => {
    show();
    await loaded();
    const requests = panel("Someone asks to use your authority");
    // Push is configured, but policy refuses it for authorization requests.
    expect(
      requests.queryByRole("option", { name: "Push notification" }),
    ).toBeNull();
    const security = panel("Something security-relevant happens");
    const offered = security
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(offered).toEqual(["Telegram", "Push notification"]);
  });

  it("adds what policy allows, and the route marks it used", async () => {
    show();
    await loaded();
    const security = panel("Something security-relevant happens");
    await userEvent.selectOptions(
      security.getByLabelText("Add a channel"),
      "native_push",
    );
    await userEvent.click(
      security.getByRole("button", {
        name: "Add Push notification to Something security-relevant happens",
      }),
    );
    await waitFor(() =>
      expect(server.byClass.get("security_event")?.channels).toEqual([
        "in_app",
        "native_push",
      ]),
    );
    const row = (await security.findByText("2. Push notification")).closest(
      "li",
    );
    if (!row) throw new Error("no row for Push notification");
    expect(within(row).getByRole("img", { name: /^Used: / })).toBeTruthy();
  });

  it("marks a channel listed before policy tightened as refused by policy", async () => {
    show();
    await loaded();
    const decided = panel("A request you sent gets decided");
    expect(
      decided.getByRole("img", {
        name: "Your operator's policy does not allow this kind of prompt to go here, so your preference for it is ignored.",
      }),
    ).toBeTruthy();
  });

  it("refuses a file that admits a channel policy refused, and the Form stays as it was", async () => {
    show();
    await loaded();
    const admitted = JSON.stringify({
      version: 1,
      byClass: {
        authorization_request: {
          channels: ["native_push", "telegram", "in_app"],
          fanOut: false,
        },
      },
    });
    expect(session.files.check(ROUTING_FILE, admitted)).toEqual({
      ok: false,
      message: `Your operator's policy does not allow Push notification for "Someone asks to use your authority". A preference can reorder and narrow what policy allows; it cannot add to it.`,
    });
    expect((await session.files.write(ROUTING_FILE, admitted)).ok).toBe(false);
    expect(server.writes()).toEqual([]);
    const requests = panel("Someone asks to use your authority");
    expect(requests.queryByText("1. Push notification")).toBeNull();
  });

  it("refuses a file that sets what it takes to approve", async () => {
    show();
    await loaded();
    const lowered = JSON.stringify({
      version: 1,
      byClass: {},
      directApprovalChannels: ["telegram"],
    });
    const outcome = await session.files.write(ROUTING_FILE, lowered);
    expect(outcome).toEqual({
      ok: false,
      message:
        "document.directApprovalChannels cannot set what it takes to approve — a preference only orders where you are told.",
    });
    expect(server.writes()).toEqual([]);
  });

  it("saves a narrowing written as a file, and the Form redraws from it", async () => {
    show();
    await loaded();
    const narrowed = JSON.stringify({
      version: 1,
      byClass: {
        authorization_request: { channels: ["in_app"], fanOut: false },
      },
    });
    expect(await session.files.write(ROUTING_FILE, narrowed)).toEqual({
      ok: true,
      path: ROUTING_FILE,
    });
    const requests = panel("Someone asks to use your authority");
    await waitFor(() => expect(requests.queryByText("1. Telegram")).toBeNull());
    expect(requests.getByText("1. OpenSesame inbox")).toBeTruthy();
  });
});

describe("Settings › Notifications — destinations", () => {
  it("begins a binding, shows its one-time value once, then disconnects", async () => {
    show();
    await loaded();
    await userEvent.click(
      panel("Channels").getByRole("button", { name: "Connect Telegram" }),
    );
    const destinations = panel("Destinations");
    expect(await destinations.findByText("n0nce-once")).toBeTruthy();
    await userEvent.click(
      destinations.getByRole("button", {
        name: "Disconnect Telegram · Personal phone",
      }),
    );
    await waitFor(() =>
      expect(destinations.queryByText("Telegram · Personal phone")).toBeNull(),
    );
    expect(destinations.queryByText("n0nce-once")).toBeNull();
    expect(server.writes()).toEqual([
      "POST /v1/notification-channels/bindings",
      "DELETE /v1/notification-channels/bindings/bind_1",
    ]);
  });
});
