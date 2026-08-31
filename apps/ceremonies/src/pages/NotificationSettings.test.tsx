/** @vitest-environment jsdom */
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalSeams } from "../lib/approvals.js";
import { NotificationSettings } from "./NotificationSettings.js";

const fetchFn = vi.hoisted(() => vi.fn());

const defaults = {
  fetchFn: approvalSeams.fetchFn,
  getAccessToken: approvalSeams.getAccessToken,
  credentialsApi: approvalSeams.credentialsApi,
};

function capabilities(kind: string, configured: boolean) {
  return {
    kind,
    canNotify: true,
    canRendezvous: true,
    canReceiveAuthenticatedCallback: false,
    canRenderDecisionActions: false,
    bindsExternalIdentity: true,
    bindsProviderTenant: false,
    supportsUserVerification: false,
    supportsTransactionBinding: false,
    canSatisfyPhishingResistance: false,
    maximumInteractionMode: "rendezvous",
    confidentiality: "minimal",
    configured,
  };
}

const CHANNELS = [
  { ...capabilities("in_app", true), maximumInteractionMode: "interactive" },
  capabilities("telegram", true),
  capabilities("slack", false),
];

const BINDINGS = [
  {
    id: "bind_1",
    kind: "telegram",
    providerId: "telegram",
    displayLabel: "Personal phone",
    state: "active",
    verification: "provider_callback_challenge",
    createdAt: "2026-01-01T00:00:00.000Z",
    // A server that leaked the authority-bearing half must not get it rendered.
    providerSubjectId: "tg-77771111",
  },
  {
    id: "bind_2",
    kind: "slack",
    providerId: "slack",
    displayLabel: "Work",
    state: "pending",
    verification: "provider_oauth_install",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

const PREFERENCES = {
  byClass: {
    authorization_request: { channels: ["telegram", "in_app"], fanOut: false },
    security_event: { channels: ["in_app"], fanOut: false },
  },
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const ROUTE = {
  steps: [
    { kind: "telegram", mode: "rendezvous", confidentiality: "minimal" },
    { kind: "in_app", mode: "interactive", confidentiality: "full" },
  ],
  fanOut: false,
  excluded: [
    { kind: "slack", reason: "adapter_unavailable" },
    { kind: "sms", reason: "no_active_binding" },
    { kind: "webhook", reason: "not_allowed_by_policy" },
  ],
};

function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Answer by URL, not by call order.
 *
 * The page fires its two loading effects concurrently, so the order the
 * requests arrive in is a React implementation detail; a fixture that depends
 * on it tests React rather than the screen. Each answer is also built fresh:
 * a `Response` body can only be read once.
 */
function seed(saveStatus = 200) {
  fetchFn.mockImplementation(async (url: string) => {
    if (url.includes("/v1/notification-channels/bindings")) {
      return json({ bindings: BINDINGS });
    }
    if (url.includes("/v1/notification-channels")) {
      return json({ channels: CHANNELS });
    }
    if (url.includes("/v1/notification-preferences/effective")) {
      return json(ROUTE);
    }
    if (url.includes("/v1/notification-preferences")) {
      return saveStatus === 200
        ? json(PREFERENCES)
        : json({ error: "nope" }, saveStatus);
    }
    return json({}, 404);
  });
}

/** Every preference *write*, in order. The GET shares the path with the PUT. */
function preferenceWrites(): RequestInit[] {
  const writes: RequestInit[] = [];
  for (const call of fetchFn.mock.calls) {
    const init: RequestInit = overlapCast(call[1] ?? {});
    if (
      String(call[0]).endsWith("/v1/notification-preferences") &&
      init.method === "PUT"
    ) {
      writes.push(init);
    }
  }
  return writes;
}

function renderSettings() {
  return render(
    <MemoryRouter>
      <NotificationSettings />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchFn.mockReset();
  Object.assign(approvalSeams, {
    fetchFn,
    getAccessToken: async () => "session-bearer",
  });
});

afterEach(() => {
  cleanup();
  Object.assign(approvalSeams, defaults);
});

describe("notification settings — the honesty surface", () => {
  it("carries the standing note that a channel choice does not lower approval security", async () => {
    seed();
    renderSettings();

    const note = await screen.findByText(
      /Choosing where you're notified doesn't change what it takes to approve/i,
    );
    expect(note.textContent).toContain(
      "High-risk requests always come back here for a passkey",
    );
    // It is a durable statement, not a transient status or an error.
    expect(note.className).toContain("note");
    expect(note.getAttribute("role")).toBeNull();
  });

  it("reads an unconfigured channel as unconfigured, and never offers it", async () => {
    seed();
    renderSettings();

    await screen.findByText(/Not set up on this deployment/i);
    expect(screen.getByText(/not set up/)).toBeTruthy();
    expect(
      screen.getByText(/Not set up on this deployment — nothing would arrive/i),
    ).toBeTruthy();
    // No "Connect Slack" button: an unconfigured channel is not an option.
    expect(screen.queryByRole("button", { name: /Connect Slack/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add Slack/i })).toBeNull();
    // …while the one that is configured is offered.
    expect(
      screen.getByRole("button", { name: /Connect Telegram/i }),
    ).toBeTruthy();
  });

  it("renders the effective route with every exclusion reason spelled out", async () => {
    seed();
    renderSettings();

    await screen.findByText(/no working adapter for this channel/i);
    expect(
      screen.getByText(/have not connected a destination for this yet/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/policy does not allow this kind of prompt to go here/i),
    ).toBeTruthy();
    // Raw reason codes never surface.
    const page = document.body.textContent ?? "";
    expect(page).not.toContain("adapter_unavailable");
    expect(page).not.toContain("no_active_binding");
    expect(page).not.toContain("not_allowed_by_policy");
  });

  it("shows binding state in words, including a pending one that delivers nothing", async () => {
    seed();
    renderSettings();

    await screen.findByText("Personal phone", { exact: false });
    expect(screen.getByText("Active")).toBeTruthy();
    expect(
      screen.getByText(/Waiting to be confirmed — nothing is delivered here/i),
    ).toBeTruthy();
  });

  it("never renders a provider subject id or the session bearer", async () => {
    seed();
    renderSettings();

    await screen.findByText(/Personal phone/);
    const page = document.body.textContent ?? "";
    expect(page).not.toContain("tg-77771111");
    expect(page).not.toContain("session-bearer");
    expect(page).not.toContain("Bearer ");
  });
});

describe("notification settings — ordering and fan-out", () => {
  it("reorders a class with accessible up/down buttons and saves", async () => {
    seed();
    renderSettings();

    await screen.findByText("1. Telegram");
    const down = screen.getByRole("button", {
      name: /Move Telegram later for Someone asks to use your authority/i,
    });
    fireEvent.click(down);

    // Scoped: every class section has its own order, and the inbox is first
    // in most of them.
    const section = screen.getByRole("region", {
      name: /Someone asks to use your authority/i,
    });
    await within(section).findByText("1. OpenSesame inbox");
    const writes = preferenceWrites();
    expect(writes).toHaveLength(1);
    const body = JSON.parse(String(writes[0]?.body ?? "{}"));
    expect(body.byClass.authorization_request.channels).toEqual([
      "in_app",
      "telegram",
    ]);
  });

  it("offers fan-out for security events and saves the toggle", async () => {
    seed();
    renderSettings();

    const fanOut = await screen.findByLabelText(
      /Tell me on every destination that works/i,
    );
    fireEvent.click(fanOut);

    await screen.findByText(/Security events will go to every destination/i);
    const writes = preferenceWrites();
    const body = JSON.parse(String(writes[writes.length - 1]?.body ?? "{}"));
    expect(body.byClass.security_event.fanOut).toBe(true);
  });

  it("keeps the screen truthful when a save is refused", async () => {
    seed();
    renderSettings();
    await screen.findByText("1. Telegram");
    // From here the server refuses every preference write.
    seed(500);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Move Telegram later for Someone asks to use your authority/i,
      }),
    );

    await screen.findByRole("alert");
    // The order rolled back rather than claiming a save that did not happen.
    expect(screen.getByText("1. Telegram")).toBeTruthy();
  });
});
