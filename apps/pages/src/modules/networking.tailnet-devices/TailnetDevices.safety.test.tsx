/** @vitest-environment jsdom */
// What the security review of ADR 0166 found, each pinned: a link names the
// daemon it would re-point the page at, a narrow credential still lists the
// devices, and a refused change never leaves a device admitted.
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import { tailnetAdminSeams } from "@opensesame/app-core/lib/tailnet-admin/client.js";
import { formatTailnetPairingCode } from "@opensesame/app-core/lib/tailnet-admin/pairing.js";
import { TAILNET_DEVICES_TARGETS } from "@opensesame/app-core/tutorial/registry/tailnet-devices-catalog.js";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureLinkedPairing } from "../../lib/pairing-link.js";
import { TailnetDevices } from "./TailnetDevices.js";
import {
  fakeDaemon,
  originalSeams,
  pairedClient,
  router,
  rowOf,
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

describe("Tailnet devices, the review's regressions", () => {
  it("on a shared-origin demo says why it cannot pair, and pairs nothing", () => {
    const admin = pairedClient(fakeDaemon([]));
    tailnetAdminSeams.pairing = () => null;
    tailnetAdminSeams.vaultReady = () => true;
    tailnetAdminSeams.eligible = () => false;
    render(<TailnetDevices admin={admin} />);
    expect(
      screen.getByRole("img", {
        name: "This shared-origin demo cannot manage tailnet devices. Use a dedicated or loopback deployment.",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Pair with the tailnet daemon" }),
    ).toBeNull();
  });

  it("a credential without the keys scope still lists the devices", async () => {
    const daemon = fakeDaemon([router()]);
    daemon.refuse = {
      path: "/v1/tailnet/keys",
      status: 502,
      body: { error: "tailscale_credential_refused" },
    };
    render(<TailnetDevices admin={pairedClient(daemon)} />);
    expect(await screen.findByRole("heading", { name: "router" })).toBeTruthy();
    const keys = within(
      screen.getByRole("region", { name: "Tailnet auth keys" }),
    );
    expect(
      keys.getByRole("img", { name: /refused the daemon's credential/ }),
    ).toBeTruthy();
  });

  it("takes a device off the tailnet before a change Tailscale may refuse", async () => {
    const daemon = fakeDaemon([router()]);
    render(<TailnetDevices admin={pairedClient(daemon)} />);
    await screen.findByRole("heading", { name: "router" });
    await userEvent.click(
      screen.getByRole("button", { name: "Settings for router" }),
    );
    const sheet = within(
      screen.getByRole("dialog", { name: "Settings for router" }),
    );
    await userEvent.click(
      sheet.getByRole("switch", { name: "Approved on the tailnet" }),
    );
    await userEvent.type(sheet.getByLabelText("Tags"), "tag:nobody");
    daemon.refuse = {
      path: "/v1/tailnet/devices/nROUTER/tags",
      status: 502,
      body: {
        error: "tailscale_rejected",
        detail: "tag:nobody is not a valid tag",
      },
    };
    await userEvent.click(sheet.getByRole("button", { name: "Save changes" }));
    await sheet.findByRole("img", { name: /tag:nobody is not a valid tag/ });
    expect(
      daemon.calls.filter((c) => c.method === "POST").map((c) => c.path),
    ).toEqual([
      "/v1/tailnet/devices/nROUTER/authorized",
      "/v1/tailnet/devices/nROUTER/tags",
    ]);
    // The list was read again after the refusal: the device shows as waiting.
    await waitFor(() =>
      expect(
        within(rowOf("router")).getByRole("img", {
          name: "Waiting for approval",
        }),
      ).toBeTruthy(),
    );
  });

  it("the pairing sheet names the daemon, the role and what it replaces", async () => {
    render(<TailnetDevices admin={pairedClient(fakeDaemon([]))} />);
    await screen.findByRole("img", { name: "No devices on the tailnet." });
    const printed = formatTailnetPairingCode({
      url: "https://other.tail9.ts.net",
      code: "c".repeat(43),
      origin: "https://ops.example.com",
      role: "read",
      label: "Someone's daemon",
    });
    window.location.hash = `#pair-tailnet=${printed}`;
    // What the boot watcher does on a link opened while the panel is up.
    act(() => captureLinkedPairing());
    const sheet = within(
      await screen.findByRole("dialog", {
        name: "Pair with the tailnet daemon",
      }),
    );
    for (const text of [
      "other.tail9.ts.net",
      "read",
      "Someone's daemon",
      "Ops laptop at desk.tail4c2e.ts.net",
    ])
      expect(sheet.getByText(text)).toBeTruthy();
    expect(
      sheet.getByRole("button", { name: "Replace the paired daemon" }),
    ).toBeTruthy();
  });
});
