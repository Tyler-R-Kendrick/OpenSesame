import { FakeNet } from "@opensesame/app-core/lib/live/live-fakes.js";
/** @vitest-environment jsdom */
/**
 * Starting a session right after a route was added (ADR 0150 §2, §6): the
 * routes the session starts with are the ones the person just added, however
 * long the seal behind the Routes panel is still taking. The Form and the
 * Routes panel each hold their own copy of the profile; before the Form read
 * the routes again at the press, a Start pressed while the seal was out began
 * a session with no carrier, and nothing on the page said so. The vault under
 * the real store is a memory whose writes take as long as the test says.
 */
import type {
  Carrier,
  CarrierFactory,
} from "@opensesame/app-core/lib/live/rendezvous.js";
import {
  currentHost,
  currentHostCarriers,
  endHosting,
  leaveLive,
  liveSeams,
} from "@opensesame/app-core/lib/live/session.js";
import {
  TRANSPORT_PATH,
  storeSeams,
} from "@opensesame/app-core/lib/live/transport-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem } from "@opensesame/vault-core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { withPassword } from "../../sections/vault/account.test-support.js";
import { LiveSharePanel } from "./LiveSharePanel.js";
import { clearJoinDraft, liveUiSeams } from "./live-hooks.js";
import { liveItemPickerCheckboxName } from "./live-item-picker-test.js";
import { withCarrier } from "./live-transport-edits.js";
import { transportSeams, useLiveTransport } from "./live-transport-hooks.js";

const github = createItem("account", "GitHub");
github.username = "octo";
withPassword(github, "correct horse battery staple");

const NOSTR = { kind: "nostr" as const, url: "wss://relay.example.com" };

const files = new Map<string, Uint8Array>();
const control = { sealMs: 0 };
const memory = {
  refresh: async () => undefined,
  read: async (tomb: string) => {
    const bytes = files.get(`${tomb}/${TRANSPORT_PATH}`);
    if (!bytes) {
      const { VfsError } = await import("@opensesame/app-core/lib/vfs.js");
      throw new VfsError("not-found", "none");
    }
    return bytes;
  },
  write: async (tomb: string, bytes: Uint8Array) => {
    await new Promise((resolve) => setTimeout(resolve, control.sealMs));
    files.set(`${tomb}/${TRANSPORT_PATH}`, bytes);
  },
};

const originalHooks = { ...vaultHooksSeams };
const originalLive = { ...liveSeams };
const originalUi = { ...liveUiSeams };
const originalTransport = { ...transportSeams };
const originalStore = { ...storeSeams };
/** The carriers the session asked its factory to open. */
let opened: string[];

beforeEach(() => {
  files.clear();
  control.sealMs = 0;
  opened = [];
  const never: CarrierFactory = (spec) => {
    opened.push(`${spec.kind} ${spec.url}`);
    return new Promise<Carrier>(() => undefined);
  };
  Object.assign(transportSeams, { tomb: () => "personal" });
  Object.assign(storeSeams, memory);
  Object.assign(vaultHooksSeams, {
    useVault: () => ({
      ...vaultStore.getSnapshot(),
      status: "unlocked" as const,
      items: [github],
    }),
    useCopySecret: () => async () => "copied" as const,
  });
  Object.assign(liveSeams, { items: () => [github] });
  Object.assign(liveUiSeams, {
    transport: new FakeNet().transports(),
    carriers: never,
    joinUrl: () => "https://example.test/OpenSesame/",
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
  Object.assign(storeSeams, originalStore);
});

/** The Form, filled in as a person fills it, up to the press. */
async function filledForm() {
  const { container } = render(<LiveSharePanel />);
  // The form lives under Advanced now; a person unfolds it to use it.
  const advanced = container.querySelector("details");
  if (advanced) advanced.open = true;
  const panel = within(container);
  await panel.findByRole("img", { name: /^Direct/ });
  fireEvent.change(panel.getByLabelText("Session name"), {
    target: { value: "Team" },
  });
  fireEvent.change(panel.getByLabelText("Share"), {
    target: { value: "items" },
  });
  fireEvent.click(
    panel.getByRole("checkbox", { name: liveItemPickerCheckboxName(github) }),
  );
  return panel;
}

const start = (panel: ReturnType<typeof within>) =>
  fireEvent.click(panel.getByRole("button", { name: "Share this vault" }));

describe("a session started right after a route was added", () => {
  it("starts with the carrier, though the seal behind the Routes panel is still out", async () => {
    const panel = await filledForm();
    // The Routes panel, a second copy of the profile: a slow seal.
    const routes = renderHook(() => useLiveTransport());
    await waitFor(() => expect(routes.result.current.loaded).toBe(true));
    control.sealMs = 150;
    let sealed: Promise<string | null> | undefined;
    act(() => {
      sealed = routes.result.current.change((now) => withCarrier(now, NOSTR));
    });
    // The panel drew it; the Form's copy has not heard of it.
    await waitFor(() =>
      expect(routes.result.current.transport.carriers).toEqual([NOSTR]),
    );
    expect(files.size).toBe(0);
    start(panel);
    await waitFor(() => expect(currentHost()).not.toBeNull());
    await sealed;

    expect(currentHostCarriers()?.states.map((state) => state.spec)).toEqual([
      NOSTR,
    ]);
    await waitFor(() => expect(opened).toEqual([`nostr ${NOSTR.url}`]));
  });

  it("starts with every route when more than one edit is queued behind the seal", async () => {
    const panel = await filledForm();
    const routes = renderHook(() => useLiveTransport());
    await waitFor(() => expect(routes.result.current.loaded).toBe(true));
    control.sealMs = 100;
    const queuedSeals: Promise<string | null>[] = [];
    act(() => {
      queuedSeals.push(
        routes.result.current.change((now) => withCarrier(now, NOSTR)),
      );
      queuedSeals.push(
        routes.result.current.change((now) =>
          withCarrier(now, { kind: "mqtt", url: "wss://broker.example.com" }),
        ),
      );
    });
    start(panel);
    await waitFor(() => expect(currentHost()).not.toBeNull());

    await waitFor(() =>
      expect(opened.slice().sort()).toEqual([
        "mqtt wss://broker.example.com",
        `nostr ${NOSTR.url}`,
      ]),
    );
    // Finish this test's writes before restoring the memory store for the next session.
    await Promise.all(queuedSeals);
  });

  it("starts direct when no route was added, and does not wait for one", async () => {
    const panel = await filledForm();
    start(panel);
    await waitFor(() => expect(currentHost()).not.toBeNull());
    expect(currentHostCarriers()).toBeNull();
    expect(opened).toEqual([]);
  });

  it("says why when the saved profile has become unusable, and starts nothing", async () => {
    const panel = await filledForm();
    files.set(
      `personal/${TRANSPORT_PATH}`,
      new TextEncoder().encode('{"relay": true, "ice": ['),
    );
    start(panel);
    expect(
      await panel.findByRole("img", { name: "The profile is not valid JSON." }),
    ).toBeTruthy();
    expect(currentHost()).toBeNull();
  });
});
