/** @vitest-environment jsdom */
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import { tailnetAdminSeams } from "@opensesame/app-core/lib/tailnet-admin/client.js";
import { TAILNET_DEVICES_TARGETS } from "@opensesame/app-core/tutorial/registry/tailnet-devices-catalog.js";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TailnetDevices } from "./TailnetDevices.js";
import {
  fakeDaemon,
  originalSeams,
  pairedClient,
  wireDevice,
} from "./fake-daemon.test-support.js";

// The panel and its add key are tutorial targets the module declares on activation.
let undeclare: Array<() => void> = [];
beforeEach(() => {
  undeclare = TAILNET_DEVICES_TARGETS.map((target) =>
    registerContributionForTest("tutorial-target", target),
  );
});
afterEach(() => {
  cleanup();
  Object.assign(tailnetAdminSeams, originalSeams);
  for (const revoke of undeclare) revoke();
});

const pending = () =>
  wireDevice({
    id: "nPHONE",
    name: "sams-phone.tail4c2e.ts.net",
    os: "iOS",
    authorized: false,
    connected: false,
    last_seen: null,
  });
const router = () =>
  wireDevice({
    id: "nROUTER",
    name: "router.tail4c2e.ts.net",
    update_available: true,
    advertised_routes: ["10.0.0.0/16", "0.0.0.0/0", "::/0"],
    enabled_routes: [],
  });

function rowOf(name: string): HTMLElement {
  const row = screen.getByRole("heading", { name }).closest("li");
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${name}`);
  return row;
}

describe("Tailnet devices", () => {
  it("offers pairing and nothing else with no daemon paired", async () => {
    tailnetAdminSeams.pairing = () => null;
    tailnetAdminSeams.subscribe = () => () => undefined;
    tailnetAdminSeams.possible = () => true;
    const admin = pairedClient(fakeDaemon([]));
    tailnetAdminSeams.pairing = () => null;
    render(<TailnetDevices admin={admin} />);
    expect(
      screen.getByRole("img", {
        name: "No daemon paired for device management.",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a device" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Pair with the tailnet daemon" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Pair with the tailnet daemon" }),
    ).toBeTruthy();
    expect(document.activeElement?.closest("[role=dialog]")).toBeTruthy();
  });

  it("lists the tailnet's real devices, waiting ones first, with what needs someone", async () => {
    const daemon = fakeDaemon([router(), pending()]);
    render(<TailnetDevices admin={pairedClient(daemon)} />);
    await screen.findByRole("heading", { name: "sams-phone" });
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(headings.slice(0, 2)).toEqual(["sams-phone", "router"]);
    const phone = within(rowOf("sams-phone"));
    expect(
      phone.getByRole("img", { name: "Waiting for approval" }),
    ).toBeTruthy();
    expect(phone.getByRole("img", { name: "Never seen" })).toBeTruthy();
    const routerRow = within(rowOf("router"));
    expect(
      routerRow.getByRole("img", { name: "2 routes waiting for approval" }),
    ).toBeTruthy();
    expect(
      routerRow.getByRole("img", { name: "Update available" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Needs attention 2" }),
    ).toBeTruthy();
  });

  it("approves a waiting device through the daemon and lands on its settings key", async () => {
    const daemon = fakeDaemon([pending()]);
    render(<TailnetDevices admin={pairedClient(daemon)} />);
    await screen.findByRole("heading", { name: "sams-phone" });
    await userEvent.click(
      screen.getByRole("button", { name: "Approve sams-phone" }),
    );
    await waitFor(() =>
      expect(
        within(rowOf("sams-phone")).queryByRole("img", {
          name: "Waiting for approval",
        }),
      ).toBeNull(),
    );
    expect(daemon.calls).toContainEqual({
      method: "POST",
      path: "/v1/tailnet/devices/nPHONE/authorized",
      body: { authorized: true },
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Settings for sams-phone" }),
      ),
    );
  });

  it("removes a device only on the armed second press; keep disarms and returns focus", async () => {
    const daemon = fakeDaemon([router()]);
    render(<TailnetDevices admin={pairedClient(daemon)} />);
    await screen.findByRole("heading", { name: "router" });
    const remove = screen.getByRole("button", {
      name: "Remove router from the tailnet",
    });
    await userEvent.click(remove);
    expect(daemon.calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Keep router" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Remove router from the tailnet" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove router from the tailnet" }),
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Confirm removing router from the tailnet",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "router" })).toBeNull(),
    );
    expect(daemon.calls).toContainEqual({
      method: "DELETE",
      path: "/v1/tailnet/devices/nROUTER",
      body: null,
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Add a device" }),
      ),
    );
  });

  it("adds a device: mints a real auth key and shows it once with the join command", async () => {
    const daemon = fakeDaemon([router()]);
    render(<TailnetDevices admin={pairedClient(daemon)} />);
    await screen.findByRole("heading", { name: "router" });
    await userEvent.click(screen.getByRole("button", { name: "Add a device" }));
    const sheet = within(screen.getByRole("dialog", { name: "Add a device" }));
    await userEvent.type(sheet.getByLabelText("Description"), "sams phone");
    await userEvent.click(sheet.getByRole("button", { name: "7 days" }));
    await userEvent.click(sheet.getByRole("switch", { name: "Reusable" }));
    await userEvent.click(
      sheet.getByRole("button", { name: "Mint an auth key" }),
    );
    expect(
      await sheet.findByDisplayValue("tskey-auth-kNEW9CNTRL-Secret0Value"),
    ).toBeTruthy();
    expect(
      sheet.getByDisplayValue(
        "tailscale up --auth-key=tskey-auth-kNEW9CNTRL-Secret0Value",
      ),
    ).toBeTruthy();
    expect(daemon.calls).toContainEqual({
      method: "POST",
      path: "/v1/tailnet/keys",
      body: {
        description: "sams phone",
        reusable: true,
        ephemeral: false,
        preauthorized: true,
        tags: [],
        expiry_seconds: 604800,
      },
    });
    await userEvent.click(sheet.getByRole("button", { name: "Done" }));
    expect(screen.queryByDisplayValue(/tskey-auth-/)).toBeNull();
    expect(
      await screen.findByRole("heading", { name: "sams phone" }),
    ).toBeTruthy();
  });

  it("an OAuth daemon mints tagged keys only, and says so before asking", async () => {
    const daemon = fakeDaemon([router()]);
    daemon.credential = "oauth";
    render(<TailnetDevices admin={pairedClient(daemon)} />);
    await screen.findByRole("heading", { name: "router" });
    await userEvent.click(screen.getByRole("button", { name: "Add a device" }));
    const sheet = within(screen.getByRole("dialog", { name: "Add a device" }));
    expect(
      sheet.getByRole("img", {
        name: "The daemon's OAuth client mints tagged keys only",
      }),
    ).toBeTruthy();
    expect(
      sheet.getByRole("button", { name: "Mint an auth key" }),
    ).toHaveProperty("disabled", true);
    await userEvent.type(sheet.getByLabelText("Tags"), "ci");
    expect(
      sheet.getByRole("button", { name: "Mint an auth key" }),
    ).toHaveProperty("disabled", false);
  });

  it("settings send only what changed: name, tags and the exit node", async () => {
    const daemon = fakeDaemon([router()]);
    render(<TailnetDevices admin={pairedClient(daemon)} />);
    await screen.findByRole("heading", { name: "router" });
    await userEvent.click(
      screen.getByRole("button", { name: "Settings for router" }),
    );
    const sheet = within(
      screen.getByRole("dialog", { name: "Settings for router" }),
    );
    const name = sheet.getByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "edge-01");
    await userEvent.type(sheet.getByLabelText("Tags"), "tag:edge");
    await userEvent.click(sheet.getByRole("switch", { name: "Exit node" }));
    await userEvent.click(sheet.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("heading", { name: "edge-01" });
    const changes = daemon.calls
      .filter((c) => c.method === "POST")
      .map((c) => [c.path, c.body]);
    expect(changes).toEqual([
      ["/v1/tailnet/devices/nROUTER/name", { name: "edge-01" }],
      ["/v1/tailnet/devices/nROUTER/tags", { tags: ["tag:edge"] }],
      [
        "/v1/tailnet/devices/nROUTER/routes",
        { enabled_routes: ["0.0.0.0/0", "::/0"] },
      ],
    ]);
  });

  it("a read pairing sees the tailnet and changes nothing", async () => {
    render(
      <TailnetDevices admin={pairedClient(fakeDaemon([pending()]), "read")} />,
    );
    await screen.findByRole("heading", { name: "sams-phone" });
    expect(screen.queryByRole("button", { name: "Add a device" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Approve sams-phone" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("says what Tailscale refused, as a mark and an alert", async () => {
    const daemon = fakeDaemon([router()]);
    daemon.refuse = {
      path: "/v1/tailnet/devices",
      status: 502,
      body: { error: "tailscale_credential_refused" },
    };
    render(<TailnetDevices admin={pairedClient(daemon)} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/refused the daemon's credential/);
  });

  it("filters to what needs someone", async () => {
    render(
      <TailnetDevices
        admin={pairedClient(
          fakeDaemon([
            pending(),
            wireDevice({ id: "nOK", name: "fine.tail4c2e.ts.net" }),
          ]),
        )}
      />,
    );
    await screen.findByRole("heading", { name: "fine" });
    await userEvent.click(
      screen.getByRole("button", { name: "Needs attention 1" }),
    );
    expect(screen.queryByRole("heading", { name: "fine" })).toBeNull();
    expect(screen.getByRole("heading", { name: "sams-phone" })).toBeTruthy();
  });
});
