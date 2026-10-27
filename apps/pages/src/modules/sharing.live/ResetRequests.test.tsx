/** @vitest-environment jsdom */
import type { DeviceReply } from "@opensesame/app-core/lib/live/device-messages.js";
import {
  type DeviceResetRequest,
  resetRequestDigest,
} from "@opensesame/app-core/lib/live/device-reset-messages.js";
import { LiveHost } from "@opensesame/app-core/lib/live/host.js";
import { FakeNet } from "@opensesame/app-core/lib/live/live-fakes.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { lockAllTombs, unlockTomb } from "@opensesame/app-core/lib/vfs.js";
import { mintVaultKey } from "@opensesame/vault-core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResetRequests } from "./ResetRequests.js";

const ORIGIN = "https://accounts.example.test";
let host: LiveHost;

beforeEach(async () => {
  unlockTomb(vaultStore.activeTomb(), (await mintVaultKey()).vaultKey);
  host = await LiveHost.start({
    admission: "open",
    expiresAt: Date.now() + 60_000,
    catalog: () => ({ title: "T", policy: "use", expiresAt: 1, items: [] }),
    readField: async () => null,
    transport: new FakeNet().transport(),
    resets: {
      items: () => [
        { id: "item-1", name: "Example account", origins: [ORIGIN] },
      ],
    },
  });
});

afterEach(() => {
  cleanup();
  host.end();
  lockAllTombs();
});

async function ask() {
  const replies: DeviceReply[] = [];
  if (!host.resets) throw new Error("Reset broker is required");
  const seat = host.resets.seat(
    { key: "agent", name: "Agent terminal" },
    (reply) => replies.push(reply),
  );
  const details = {
    origin: ORIGIN,
    item: "item-1",
    runtime: "agent-browser",
    model: "decision-model",
    expiresAt: Date.now() + 30_000,
    actions: ["password_reset.item.use"] as const,
  };
  const request: DeviceResetRequest = {
    t: "dev.reset",
    req: "item-request",
    ...details,
    digest: await resetRequestDigest(details),
  };
  await act(async () => seat.handle(request));
  return { seat, replies };
}

describe("reset approvals", () => {
  it("reviews one exact capability through ManageGrants and shows human status", async () => {
    const { seat } = await ask();
    const view = render(<ResetRequests host={host} />);
    const screen = within(view.container);
    expect(screen.getByText("password_reset.item.use")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Review password_reset.item.use" }),
    );
    expect(screen.getByText(ORIGIN)).toBeTruthy();
    expect(screen.getByText("decision-model")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Approve reset capability" }),
    );
    await waitFor(() => expect(host.state.resets?.grants).toHaveLength(1));
    view.rerender(<ResetRequests host={host} />);
    expect(screen.queryByText("Review reset capability")).toBeNull();

    await act(async () =>
      seat.handle({
        t: "dev.reset.status",
        req: "takeover-status",
        grant: "reset-item-request",
        status: "takeover_requested",
      }),
    );
    view.rerender(<ResetRequests host={host} />);
    expect(
      screen.getByRole("img", { name: "Human takeover requested" }),
    ).toBeTruthy();
    expect(view.container.textContent).not.toContain("pepper");
  });
});
