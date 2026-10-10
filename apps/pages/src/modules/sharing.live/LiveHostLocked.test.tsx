/** @vitest-environment jsdom */
/**
 * A locked live session says so with one mark (ADR 0150 §3): five wrong codes
 * stop it taking new requests, the session itself stays live for everyone in,
 * and the owner sees why nobody new can get in.
 */
import { LiveGuest } from "@opensesame/app-core/lib/live/guest.js";
import { LiveHost, MAX_MISSES } from "@opensesame/app-core/lib/live/host.js";
import { FakeNet } from "@opensesame/app-core/lib/live/live-fakes.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { RequestPaste } from "./LiveHostGuests.js";
import { LiveHostSession } from "./LiveHostSession.js";
import { liveUiSeams } from "./live-hooks.js";

const originalHooks = { ...vaultHooksSeams };
const originalUi = { ...liveUiSeams };
const hosts: LiveHost[] = [];

beforeEach(() => {
  Object.assign(vaultHooksSeams, {
    useVault: () => ({
      ...vaultStore.getSnapshot(),
      status: "unlocked" as const,
      items: [],
    }),
  });
  Object.assign(liveUiSeams, { joinUrl: () => "https://example.test/" });
});

afterEach(() => {
  cleanup();
  for (const host of hosts.splice(0)) host.end();
  Object.assign(vaultHooksSeams, originalHooks);
  Object.assign(liveUiSeams, originalUi);
});

async function invite() {
  const net = new FakeNet();
  const host = await LiveHost.start({
    admission: "invite",
    expiresAt: Date.now() + 60_000,
    catalog: () => ({ title: "T", policy: "read", expiresAt: 1, items: [] }),
    readField: async () => null,
    transport: net.transport(),
  });
  hosts.push(host);
  return { host, net };
}

describe("the owner's view of a session", () => {
  it("shows one warning mark once the session is locked, and not before", async () => {
    const { host, net } = await invite();
    const view = render(<LiveHostSession host={host} state={host.state} />);
    const shown = within(view.container);
    expect(shown.getByRole("img", { name: "Live" })).toBeTruthy();
    expect(shown.queryByRole("img", { name: /Locked/ })).toBeNull();
    for (let miss = 0; miss < MAX_MISSES; miss += 1) {
      const guest = new LiveGuest({
        link: host.link,
        code: `BCDF-GHJ${miss}`,
        name: "Mallory",
        note: "",
        transport: net.transport(),
      });
      await host.receive(await guest.start());
      guest.leave();
    }
    expect(host.state.locked).toBe(true);
    view.rerender(<LiveHostSession host={host} state={host.state} />);
    expect(
      shown.getAllByRole("img", { name: "Locked: too many wrong codes" }),
    ).toHaveLength(1);
    // Locked is not ended: the session is still live.
    expect(shown.getByRole("img", { name: "Live" })).toBeTruthy();
  });
  it("says so when a code is pasted into a locked session, and keeps the text", async () => {
    const { host, net } = await invite();
    for (let miss = 0; miss < MAX_MISSES; miss += 1) {
      const guest = new LiveGuest({
        link: host.link,
        code: `BCDF-GHJ${miss}`,
        name: "Mallory",
        note: "",
        transport: net.transport(),
      });
      await host.receive(await guest.start());
      guest.leave();
    }
    const late = new LiveGuest({
      link: host.link,
      code: "BCDF-GHJZ",
      name: "Late",
      note: "",
      transport: net.transport(),
    });
    const code = await late.start();
    late.leave();
    const paste = within(render(<RequestPaste host={host} />).container);
    const field = paste.getByLabelText("A request code");
    fireEvent.change(field, { target: { value: code } });
    fireEvent.click(paste.getByRole("button", { name: "Read the request" }));
    await paste.findByRole("img", { name: "The session is locked" });
    expect(field).toHaveProperty("value", code);
  });
});
