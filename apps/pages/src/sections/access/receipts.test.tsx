import { webLocksDouble } from "@opensesame/app-core/lib/__tests__/web-locks-double.js";
import {
  type IdentitySession,
  identitySeams,
} from "@opensesame/app-core/lib/identity.js";
/** @vitest-environment jsdom */
import { changeLocalDirectory } from "@opensesame/app-core/lib/local-directory-admin.js";
import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import { notifyLocalIamChange } from "@opensesame/app-core/lib/local-iam-events.js";
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  loadSettings,
  saveSettings,
} from "@opensesame/app-core/lib/settings.js";
import { lockAllTombs, unlockTomb } from "@opensesame/app-core/lib/vfs.js";
import { mintVaultKey } from "@opensesame/vault-core";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectInTray } from "../../components/tray.test-support.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { Receipts } from "./receipts.js";
import { renderAccess as render } from "./workspace-test-support.js";

const at = "2026-10-04T10:00:00.000Z";
const SESSION: IdentitySession = {
  principalId: "prn_a",
  accessToken: "t",
  issuerOrigin: "x",
};

let tomb: string;
let appId: string;
const real = { ...identitySeams };
const realUseVault = vaultHooksSeams.useVault;
const identityJson = vi.fn();
const connectProvisional = vi.fn();

function event(id: string, eventType: string, outcome = "succeeded") {
  return {
    id,
    occurredAt: at,
    eventType,
    outcome,
    metadata: { targetType: "application", targetId: appId },
  };
}

function identityAt(identityApi: string): void {
  saveSettings({ ...loadSettings(), identityApi });
}

beforeEach(async () => {
  identityAt("");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: webLocksDouble(),
  });
  tomb = `receipts-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  const next = await changeLocalDirectory(
    tomb,
    (await readLocalDirectory(tomb)).revision,
    { action: "create", kind: "application", name: "Test application" },
  );
  appId = next.entries.find((row) => row.kind === "application")?.id ?? "";
  vaultHooksSeams.useVault = () => ({ ...realUseVault(), tomb });
  identityJson.mockReset();
  identityJson.mockResolvedValue({
    events: [
      event("e3", "access.sign_in.revoked"),
      event("e2", "access.request.denied", "denied"),
      {
        id: "e1",
        occurredAt: at,
        eventType: "auth.login",
        outcome: "succeeded",
      },
    ],
  });
  connectProvisional.mockReset();
  connectProvisional.mockResolvedValue(SESSION);
  identitySeams.identityJson = identityJson;
  identitySeams.currentSession = () => null;
  identitySeams.connectProvisional = connectProvisional;
});
afterEach(() => {
  Object.assign(identitySeams, real);
  vaultHooksSeams.useVault = realUseVault;
  cleanup();
  lockAllTombs();
  identityAt("");
});

describe("Receipts on the device plane (ADR 0162)", () => {
  it("says each decision in words, names the application, and leaves out what is not a receipt", async () => {
    render(
      <Receipts online={true} sessionKey={tomb} />,
      "/access?view=sessions#access-receipts",
    );
    expect(
      await screen.findByRole("treeitem", {
        name: /Application\ sign\-in\ ended\ ·\ Test\ application.*receipt/,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("treeitem", {
        name: /Request\ denied\ ·\ Test\ application.*receipt/,
      }),
    ).toBeTruthy();
    expect(screen.queryByText("auth.login")).toBeNull();
  });

  it("mints the device's own session to read with when the page has none yet", async () => {
    render(
      <Receipts online={true} sessionKey={tomb} />,
      "/access?view=sessions#access-receipts",
    );
    await screen.findByRole("treeitem", {
      name: /Request\ denied\ ·\ Test\ application.*receipt/,
    });
    expect(connectProvisional).toHaveBeenCalled();
  });

  it("shows an id when the directory has no name for it", async () => {
    identityJson.mockResolvedValue({
      events: [
        {
          ...event("e9", "access.request.created"),
          metadata: { targetType: "application", targetId: "local_unnamed" },
        },
      ],
    });
    render(
      <Receipts online={true} sessionKey={tomb} />,
      "/access?view=sessions#access-receipts",
    );
    expect(
      await screen.findByRole("treeitem", {
        name: /Request\ raised\ ·\ local_unnamed.*receipt/,
      }),
    ).toBeTruthy();
  });

  it("reads the vault's own trail offline: nothing here needs a network", async () => {
    render(
      <Receipts online={false} sessionKey={tomb} />,
      "/access?view=sessions#access-receipts",
    );
    await screen.findByRole("treeitem", {
      name: /Request\ denied\ ·\ Test\ application.*receipt/,
    });
    expect(screen.queryByText("Offline.")).toBeNull();
    expect(identityJson).toHaveBeenCalledWith("/v1/audit/events?limit=50");
  });

  it("names no service while it reads, and none when it cannot", async () => {
    identityJson.mockReturnValue(new Promise(() => undefined));
    const { container } = render(
      <Receipts online={true} sessionKey={tomb} />,
      "/access?view=sessions#access-receipts",
    );
    expect(container.textContent).toContain("Reading receipts…");
    expect(container.textContent).not.toMatch(/Identity|service/i);
    cleanup();
    identityJson.mockRejectedValue(new Error("boom"));
    const failed = render(
      <Receipts online={true} sessionKey={tomb} />,
      "/access?view=sessions#access-receipts",
    );
    await waitFor(() => expect(listNotices()).not.toHaveLength(0));
    const tray = listNotices().map((n) => `${n.title} ${n.body}`);
    expect(tray.join(" ")).not.toMatch(/Identity|service|unreachable|http/i);
    expect(failed.container.textContent).not.toMatch(
      /Identity|service|unreachable|http/i,
    );
  });

  it("marks the panel and trays the sentence when the trail cannot be read", async () => {
    identityJson.mockRejectedValue(new Error("boom"));
    const { container } = render(
      <Receipts online={true} sessionKey={tomb} />,
      "/access?view=sessions#access-receipts",
    );
    const sentence = "Receipts did not load. Reload to read them again.";
    await expectInTray(sentence);
    expect(screen.getByRole("img", { name: sentence })).toBeTruthy();
    expect(container.querySelector(".panel__body")?.textContent).not.toBe("");
    expect(screen.queryByText("No receipts yet.")).toBeNull();
  });

  it("reads again when a decision lands, in this tab", async () => {
    render(
      <Receipts online={true} sessionKey={tomb} />,
      "/access?view=sessions#access-receipts",
    );
    await screen.findByRole("treeitem", {
      name: /Request\ denied\ ·\ Test\ application.*receipt/,
    });
    identityJson.mockResolvedValue({
      events: [event("e4", "access.request.approved")],
    });
    await act(async () => {
      notifyLocalIamChange();
    });
    expect(
      await screen.findByRole("treeitem", {
        name: /Request\ approved\ ·\ Test\ application.*receipt/,
      }),
    ).toBeTruthy();
  });

  it("says when decisions are made and not yet written, and not when none wait", async () => {
    identityJson.mockResolvedValue({
      events: [event("e8", "access.request.denied", "denied")],
      pending: 2,
    });
    const { container, rerender } = render(
      <Receipts online={true} sessionKey={tomb} />,
    );
    await screen.findByRole("treeitem", {
      name: /Request\ denied\ ·\ Test\ application.*receipt/,
    });
    expect(
      container.querySelector('[aria-label="2 receipts not written yet"]'),
    ).not.toBeNull();
    identityJson.mockResolvedValue({
      events: [event("e8", "access.request.denied", "denied")],
      pending: 0,
    });
    await act(async () => {
      notifyLocalIamChange();
    });
    rerender(<Receipts online={true} sessionKey={tomb} />);
    await screen.findByRole("treeitem", {
      name: /Request\ denied\ ·\ Test\ application.*receipt/,
    });
    expect(
      container.querySelector('[aria-label$="not written yet"]'),
    ).toBeNull();
  });

  it("words the end of a session by the person it was for", async () => {
    identityJson.mockResolvedValue({
      events: [
        {
          ...event("e7", "access.session.revoked"),
          metadata: { targetType: "principal", targetId: appId },
        },
      ],
    });
    render(
      <Receipts online={true} sessionKey={tomb} />,
      "/access?view=sessions#access-receipts",
    );
    expect(
      await screen.findByRole("treeitem", {
        name: /Session\ ended\ ·\ Test\ application.*receipt/,
      }),
    ).toBeTruthy();
  });

  it("says there are none when there are none", async () => {
    identityJson.mockResolvedValue({ events: [] });
    render(
      <Receipts online={true} sessionKey={tomb} />,
      "/access?view=sessions#access-receipts",
    );
    expect(await screen.findByText("No receipts yet.")).toBeTruthy();
  });
});

describe("Receipts on a remote Identity plane", () => {
  beforeEach(() => identityAt("https://identity.example.test"));

  it("needs the network, and says so when there is none", async () => {
    render(<Receipts online={false} sessionKey="prn_a" />);
    await expectInTray("Offline.");
    expect(screen.getByRole("img", { name: "Offline." })).toBeTruthy();
    expect(screen.queryByText("No receipts yet.")).toBeNull();
    expect(identityJson).not.toHaveBeenCalled();
  });

  it("mints no session of its own: it is asked with the one it holds", async () => {
    identitySeams.currentSession = () => SESSION;
    render(<Receipts online={true} sessionKey="prn_a" />);
    await screen.findByRole("treeitem", { name: /^Application sign-in ended/ });
    expect(connectProvisional).not.toHaveBeenCalled();
  });

  it("asks Identity, and shows an event it was sent under the name it sent", async () => {
    identityJson.mockResolvedValue({
      events: [
        {
          id: "r1",
          occurredAt: at,
          eventType: "agent.invoke.finished",
          outcome: "succeeded",
        },
      ],
    });
    render(<Receipts online={true} sessionKey="prn_a" />);
    expect(
      await screen.findByRole("treeitem", {
        name: /agent\.invoke\.finished.*receipt/,
      }),
    ).toBeTruthy();
  });
});
