/** @vitest-environment jsdom */
/**
 * The owner's side of device authorization, on screen (ADR 0196): a request
 * shows the code the device is showing, allowing it is a choice of
 * connections and a time, and a grant can be taken back.
 */
import {
  type ConnectionPort,
  bindConnectionPort,
  connectionPort,
} from "@opensesame/app-core/lib/live/connection-port.js";
import type { DeviceReply } from "@opensesame/app-core/lib/live/device-messages.js";
import { LiveHost } from "@opensesame/app-core/lib/live/host.js";
import { FakeNet } from "@opensesame/app-core/lib/live/live-fakes.js";
import { listNotices } from "@opensesame/app-core/lib/notices.js";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { LiveHostSession } from "./LiveHostSession.js";
import { liveUiSeams } from "./live-hooks.js";

const originalHooks = { ...vaultHooksSeams };
const originalUi = { ...liveUiSeams };
const hosts: LiveHost[] = [];
let release: (() => void) | null = null;

const GITHUB = {
  id: "c-github",
  label: "GitHub (work)",
  provider: "github",
  operations: ["provider.read"],
};
const LINEAR = {
  id: "c-linear",
  label: "Linear",
  provider: "linear",
  operations: ["provider.read"],
};

beforeEach(async () => {
  // Allowing runs the vault's `manage_grants` check, which reads the tomb.
  unlockTomb(vaultStore.activeTomb(), (await mintVaultKey()).vaultKey);
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
  lockAllTombs();
  release?.();
  release = null;
  for (const host of hosts.splice(0)) host.end();
  Object.assign(vaultHooksSeams, originalHooks);
  Object.assign(liveUiSeams, originalUi);
});

async function session(devices = true) {
  const port: ConnectionPort = {
    list: () => [GITHUB, LINEAR],
    invoke: async () => ({
      label: "Account",
      items: [{ id: "u", label: "ada" }],
    }),
  };
  release = bindConnectionPort(port);
  const host = await LiveHost.start({
    admission: "open",
    expiresAt: Date.now() + 60 * 60_000,
    catalog: () => ({ title: "T", policy: "use", expiresAt: 1, items: [] }),
    readField: async () => null,
    transport: new FakeNet().transport(),
    devices: devices ? { port: connectionPort } : undefined,
  });
  hosts.push(host);
  return host;
}

/** A device asking, without the network: the seat's broker end directly. */
async function ask(host: LiveHost, name = "work laptop", key = "s1") {
  const replies: DeviceReply[] = [];
  const seat = host.devices?.seat({ key, name }, (reply) =>
    replies.push(reply),
  );
  await act(async () => {
    await seat?.handle({ t: "dev.begin", req: "b1", want: [] });
  });
  return { seat, replies };
}

function view(host: LiveHost) {
  const shown = render(<LiveHostSession host={host} state={host.state} />);
  const again = () =>
    shown.rerender(<LiveHostSession host={host} state={host.state} />);
  return { screen: within(shown.container), again };
}

describe("a device asking", () => {
  it("shows nothing where devices may not ask", async () => {
    const host = await session(false);
    const { screen } = view(host);
    expect(screen.queryByRole("button", { name: /^Allow/ })).toBeNull();
  });

  it("shows the device and its code, and the key to allow or turn it down", async () => {
    const host = await session();
    const { replies } = await ask(host);
    const { screen } = view(host);
    const code = replies.find((reply) => reply.t === "dev.code");
    expect(screen.getByText("work laptop")).toBeTruthy();
    expect(
      screen.getByText(code?.t === "dev.code" ? code.userCode : "never"),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Asking to use your connections" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Allow work laptop" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Turn work laptop down" }),
    ).toBeTruthy();
  });

  it("turns a request down, and tells the device", async () => {
    const host = await session();
    const { replies } = await ask(host);
    const { screen, again } = view(host);
    fireEvent.click(
      screen.getByRole("button", { name: "Turn work laptop down" }),
    );
    again();
    expect(replies.at(-1)).toEqual({
      t: "dev.auth",
      req: "b1",
      state: "access_denied",
    });
    expect(screen.queryByText("work laptop")).toBeNull();
  });
});

describe("allowing a device", () => {
  async function sheet() {
    const host = await session();
    const asked = await ask(host);
    const { screen, again } = view(host);
    fireEvent.click(screen.getByRole("button", { name: "Allow work laptop" }));
    const dialog = within(
      await screen.findByRole("dialog", { name: "Allow a device" }),
    );
    return { host, ...asked, screen, again, dialog };
  }

  it("offers the connections, allows none until one is chosen", async () => {
    const { dialog } = await sheet();
    expect(dialog.getByLabelText("GitHub (work)")).toBeTruthy();
    expect(dialog.getByLabelText("Linear")).toBeTruthy();
    const allow = dialog.getByRole("button", { name: "Allow work laptop" });
    expect(allow).toHaveProperty("disabled", true);
    fireEvent.click(dialog.getByLabelText("GitHub (work)"));
    expect(allow).toHaveProperty("disabled", false);
    // The device's code is on the sheet, to compare.
    expect(dialog.getByText(/^[A-Z]{4}-[A-Z]{4}$/)).toBeTruthy();
  });

  it("grants what was chosen, tells the device, and shows the grant", async () => {
    const { host, replies, dialog, screen, again } = await sheet();
    fireEvent.click(dialog.getByLabelText("Linear"));
    fireEvent.click(dialog.getByRole("button", { name: "Allow work laptop" }));
    await waitFor(() => expect(host.state.devices.grants).toHaveLength(1));
    again();
    const granted = replies.at(-1);
    expect(granted).toMatchObject({ t: "dev.auth", state: "granted" });
    expect(
      granted?.t === "dev.auth" ? granted.connections?.map((c) => c.id) : [],
    ).toEqual(["c-linear"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(/Linear · /)).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Using your connections" }),
    ).toBeTruthy();
    expect(host.state.devices.grants).toHaveLength(1);
    // The keyboard is not left on the row that went.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Revoke work laptop" }),
    );
  });

  it("says so when the connections went away while the sheet was open", async () => {
    const { dialog } = await sheet();
    release?.();
    release = null;
    fireEvent.click(dialog.getByLabelText("Linear"));
    fireEvent.click(dialog.getByRole("button", { name: "Allow work laptop" }));
    expect(
      await dialog.findByRole("img", { name: "Connections are not available" }),
    ).toBeTruthy();
  });

  it("allows nothing when the check cannot be answered, and says it failed rather than that it was refused", async () => {
    const { host, dialog } = await sheet();
    // A locked vault cannot answer the check at all.
    lockAllTombs();
    fireEvent.click(dialog.getByLabelText("Linear"));
    fireEvent.click(dialog.getByRole("button", { name: "Allow work laptop" }));
    expect(
      await dialog.findByRole("img", { name: "Could not allow the device" }),
    ).toBeTruthy();
    expect(host.state.devices.grants).toEqual([]);
    expect(host.state.devices.pending).toHaveLength(1);
    // The failure is in the tray as well as on the sheet.
    expect(
      listNotices().some((notice) => notice.id === "live-device-allow"),
    ).toBe(true);
  });

  it("revokes a grant, and the device is told it is over", async () => {
    const { host, replies, dialog, screen, again } = await sheet();
    fireEvent.click(dialog.getByLabelText("Linear"));
    fireEvent.click(dialog.getByRole("button", { name: "Allow work laptop" }));
    await waitFor(() => expect(host.state.devices.grants).toHaveLength(1));
    again();
    fireEvent.click(screen.getByRole("button", { name: "Revoke work laptop" }));
    again();
    expect(host.state.devices.grants).toEqual([]);
    expect(
      screen.queryByRole("button", { name: "Revoke work laptop" }),
    ).toBeNull();
    expect(replies.at(-1)?.t).toBe("dev.auth");
  });
});

describe("what the owner is shown of a session with devices", () => {
  it("lists every call a device made, even identical ones in the same instant", async () => {
    const host = await session();
    const entry = {
      at: 1_800_000_000_000,
      guest: "s1",
      what: "invoke" as const,
      item: "c-github",
      field: "provider.read",
    };
    const complaints = vi.spyOn(console, "error").mockImplementation(() => {});
    const shown = render(
      <LiveHostSession
        host={host}
        state={{ ...host.state, log: [entry, entry, entry] }}
      />,
    );
    const lines = within(shown.container).getAllByRole("img", {
      name: /invoke · GitHub \(work\) provider\.read/,
    });
    expect(lines).toHaveLength(3);
    expect(complaints).not.toHaveBeenCalled();
    complaints.mockRestore();
  });

  it("marks a device in the list of guests", async () => {
    const host = await session();
    // A seated device: the host's own record of a seat of that kind.
    const { LiveGuest } = await import(
      "@opensesame/app-core/lib/live/guest.js"
    );
    const net = new FakeNet();
    const guest = new LiveGuest({
      link: host.link,
      code: host.code,
      name: "laptop",
      note: "",
      transport: net.transport(),
      kind: "device",
    });
    await host.receive(await guest.start());
    const { screen } = view(host);
    expect(screen.getByText("laptop")).toBeTruthy();
    expect(screen.getByText("A device")).toBeTruthy();
    guest.leave();
  });
});
