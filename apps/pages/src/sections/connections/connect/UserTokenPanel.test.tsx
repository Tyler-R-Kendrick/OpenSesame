/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserTokenPanel } from "./UserTokenPanel.js";

const seams = vi.hoisted(() => ({
  open: vi.fn(),
  authorize: vi.fn(),
  check: vi.fn(),
}));

vi.mock("@opensesame/app-core/lib/connections.js", () => ({
  openConsentPopup: seams.open,
}));
vi.mock("@opensesame/app-core/lib/vercel-connect-manage.js", () => ({
  authorizeConnectorAs: seams.authorize,
  checkConnectorToken: seams.check,
}));

function popup() {
  return {
    closed: false,
    close: vi.fn(),
    location: { href: "about:blank" },
  };
}

function popupSource(value: ReturnType<typeof popup>): MessageEventSource {
  return value as unknown as MessageEventSource;
}

function renderPanel() {
  render(
    <UserTokenPanel
      connectorId="con_1"
      subjectId="you"
      scopes={["read"]}
      canManage
      canProve
      online
      onFlash={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("user token authorization popup", () => {
  it("waits for this popup's own connection message before proving", async () => {
    const opened = popup();
    seams.open.mockReturnValue(opened);
    seams.authorize.mockResolvedValue({
      authorizationUrl: "https://connect.example/authorize",
    });
    seams.check.mockResolvedValue({
      subject: "user",
      expiresAt: "",
      scopes: ["read"],
      fingerprint: "0123456789ab",
      verified: null,
    });
    renderPanel();
    await userEvent.click(
      screen.getByRole("button", { name: "Authorize as you" }),
    );
    await waitFor(() =>
      expect(opened.location.href).toBe("https://connect.example/authorize"),
    );
    expect(seams.check).not.toHaveBeenCalled();

    // Another same-origin window, and this popup reporting another
    // connection, cannot settle this authorization.
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: {} as MessageEventSource,
        data: { type: "opensesame:connection", connectionId: "con_1" },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: popupSource(opened),
        data: { type: "opensesame:connection", connectionId: "con_2" },
      }),
    );
    await Promise.resolve();
    expect(seams.check).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: popupSource(opened),
        data: { type: "opensesame:connection", connectionId: "con_1" },
      }),
    );
    await waitFor(() => expect(seams.check).toHaveBeenCalledTimes(1));
  });

  it("does not prove when the popup closes without consent", async () => {
    const opened = popup();
    opened.closed = true;
    seams.open.mockReturnValue(opened);
    seams.authorize.mockResolvedValue({
      authorizationUrl: "https://connect.example/authorize",
    });
    renderPanel();
    await userEvent.click(
      screen.getByRole("button", { name: "Authorize as you" }),
    );
    await waitFor(() => expect(seams.authorize).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(seams.check).not.toHaveBeenCalled();
  });

  it("removes its consent listener when the panel unmounts", async () => {
    const opened = popup();
    seams.open.mockReturnValue(opened);
    seams.authorize.mockResolvedValue({
      authorizationUrl: "https://connect.example/authorize",
    });
    const view = render(
      <UserTokenPanel
        connectorId="con_1"
        subjectId="you"
        scopes={["read"]}
        canManage
        canProve
        online
        onFlash={vi.fn()}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Authorize as you" }),
    );
    await waitFor(() => expect(seams.authorize).toHaveBeenCalledTimes(1));
    view.unmount();
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: popupSource(opened),
        data: { type: "opensesame:connection", connectionId: "con_1" },
      }),
    );
    await Promise.resolve();
    expect(seams.check).not.toHaveBeenCalled();
  });

  it("navigates this tab and never polls when noopener returns no handle", async () => {
    seams.open.mockReturnValue(null);
    seams.authorize.mockResolvedValue({
      authorizationUrl: "https://connect.example/authorize",
    });
    const assign = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      origin: window.location.origin,
      assign,
    });
    renderPanel();
    await userEvent.click(
      screen.getByRole("button", { name: "Authorize as you" }),
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://connect.example/authorize"),
    );
    expect(seams.check).not.toHaveBeenCalled();
  });
});
