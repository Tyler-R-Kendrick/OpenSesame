/** @vitest-environment jsdom */
/**
 * Starting a session that lets devices ask (ADR 0196): the choice is drawn
 * only where there is a connection to lend, a session may share nothing of
 * the vault and exist only for devices, and a session that shares nothing and
 * lets nothing ask is not one that can start.
 */
import {
  type ConnectionPort,
  bindConnectionPort,
} from "@opensesame/app-core/lib/live/connection-port.js";
import { DeviceBroker } from "@opensesame/app-core/lib/live/device-broker.js";
import { FakeNet } from "@opensesame/app-core/lib/live/live-fakes.js";
import {
  currentHost,
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
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { withPassword } from "../../sections/vault/account.test-support.js";
import { LiveHostPanel } from "./LiveHostPanel.js";
import { clearJoinDraft, liveUiSeams } from "./live-hooks.js";
import { liveItemPickerCheckboxName } from "./live-item-picker-test.js";
import { transportSeams } from "./live-transport-hooks.js";

const github = createItem("account", "GitHub");
github.username = "octo";
withPassword(github, "correct horse battery staple");

const files = new Map<string, Uint8Array>();
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
    files.set(`${tomb}/${TRANSPORT_PATH}`, bytes);
  },
};

const originalHooks = { ...vaultHooksSeams };
const originalLive = { ...liveSeams };
const originalUi = { ...liveUiSeams };
const originalTransport = { ...transportSeams };
const originalStore = { ...storeSeams };
let release: (() => void) | null = null;

const port: ConnectionPort = {
  list: () => [
    {
      id: "c-github",
      label: "GitHub (work)",
      provider: "github",
      operations: ["provider.read"],
    },
  ],
  invoke: async () => ({ label: "x", items: [] }),
};

beforeEach(() => {
  files.clear();
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
    joinUrl: () => "https://example.test/OpenSesame/",
  });
});

afterEach(() => {
  clearJoinDraft();
  release?.();
  release = null;
  leaveLive();
  endHosting();
  cleanup();
  Object.assign(vaultHooksSeams, originalHooks);
  Object.assign(liveSeams, originalLive);
  Object.assign(liveUiSeams, originalUi);
  Object.assign(transportSeams, originalTransport);
  Object.assign(storeSeams, originalStore);
});

async function form() {
  const { container } = render(<LiveHostPanel />);
  const panel = within(container);
  await panel.findByRole("img", { name: "Direct only" });
  fireEvent.change(panel.getByLabelText("Session name"), {
    target: { value: "Team" },
  });
  return panel;
}

const choose = (
  panel: ReturnType<typeof within>,
  label: string,
  option: string,
) => {
  const select = panel.getByLabelText(label);
  const picked = within(select).getByRole("option", { name: option });
  fireEvent.change(select, {
    target: { value: picked.getAttribute("value") },
  });
};

const startKey = (panel: ReturnType<typeof within>) =>
  panel.getByRole("button", { name: /^Start the live session/ });

describe("where there is nothing to lend", () => {
  it("draws no choice about devices, and no way to share nothing", async () => {
    const panel = await form();
    expect(panel.queryByLabelText("Devices")).toBeNull();
    expect(panel.queryByRole("option", { name: "Nothing" })).toBeNull();
    fireEvent.click(
      panel.getByRole("checkbox", { name: liveItemPickerCheckboxName(github) }),
    );
    fireEvent.click(startKey(panel));
    await waitFor(() => expect(currentHost()).not.toBeNull());
    expect(currentHost()?.devices).toBeNull();
  });
});

describe("where there is a connection to lend", () => {
  beforeEach(() => {
    release = bindConnectionPort(port);
  });

  it("starts a session that shares nothing of the vault and lets devices ask", async () => {
    const panel = await form();
    expect(panel.getByLabelText("Devices")).toBeTruthy();
    choose(panel, "Share", "Nothing");
    // Nothing shared and nothing asked: the key says what is missing.
    expect(startKey(panel).getAttribute("title")).toBe(
      "Start the live session. Share an item, or let devices ask",
    );
    choose(panel, "Devices", "May ask");
    fireEvent.click(startKey(panel));
    await waitFor(() => expect(currentHost()).not.toBeNull());
    expect(currentHost()?.devices).toBeInstanceOf(DeviceBroker);
    // The vault is not in the catalog of a session that shares nothing.
    expect(currentHost()?.state.guests.length).toBe(0);
  });

  it("lets devices ask beside shared items", async () => {
    const panel = await form();
    fireEvent.click(
      panel.getByRole("checkbox", { name: liveItemPickerCheckboxName(github) }),
    );
    choose(panel, "Devices", "May ask");
    fireEvent.click(startKey(panel));
    await waitFor(() => expect(currentHost()).not.toBeNull());
    expect(currentHost()?.devices).toBeInstanceOf(DeviceBroker);
  });

  it("does not let devices ask unless they are asked about", async () => {
    const panel = await form();
    fireEvent.click(
      panel.getByRole("checkbox", { name: liveItemPickerCheckboxName(github) }),
    );
    fireEvent.click(startKey(panel));
    await waitFor(() => expect(currentHost()).not.toBeNull());
    expect(currentHost()?.devices).toBeNull();
  });
});
