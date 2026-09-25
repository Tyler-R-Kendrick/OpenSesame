import { DEVICE_APPROVAL_NOTICE } from "@opensesame/app-core/lib/device-approval.js";
/** @vitest-environment jsdom */
/**
 * `/device`: the code a link carried is shown for the person to confirm,
 * the key that approves it holds the focus, and the approval is the same
 * call Identity › Devices makes (`directory.ts` → ceremony-kit).
 */
import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";
import {
  captureDeviceLinkFromPage,
  resetDeviceArrivalForTests,
} from "@opensesame/app-core/lib/device-link.js";
import {
  DirectoryError,
  directorySeams,
} from "@opensesame/app-core/lib/directory.js";
import type { IdentitySession } from "@opensesame/app-core/lib/identity.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { overlapCast } from "@opensesame/os-domain";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityHookSeams } from "../../bindings/identity.js";
import { useOnlineSeams } from "../../lib/use-online.js";
import { DeviceRoute } from "./DeviceRoute.js";

const session: { current: IdentitySession | null } = { current: null };
const approveDevice = vi.fn();
const originalApprove = directorySeams.approveDevice;
const originalRemote = deviceIdentitySeams.remoteIdentityApi;

Object.assign(identityHookSeams, {
  useConnect: () => ({ connect: vi.fn(), connecting: false, error: null }),
  useIdentitySession: () => session.current,
});
Object.assign(useOnlineSeams, { useOnline: () => true });

function show(path = "/device") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <DeviceRoute />
    </MemoryRouter>,
  );
}

function trayed() {
  return listNotices().find((notice) => notice.id === DEVICE_APPROVAL_NOTICE);
}

beforeEach(() => {
  session.current = overlapCast({ accessToken: "t", issuerOrigin: "x" });
  deviceIdentitySeams.remoteIdentityApi = () => "http://127.0.0.1:8788";
  directorySeams.approveDevice = approveDevice;
  approveDevice.mockResolvedValue({ ok: true, status: 200 });
  clearNotices();
});

afterEach(() => {
  cleanup();
  approveDevice.mockReset();
  directorySeams.approveDevice = originalApprove;
  deviceIdentitySeams.remoteIdentityApi = originalRemote;
  resetDeviceArrivalForTests();
  history.replaceState(null, "", "/");
});

describe("the /device route", () => {
  it("shows the arrived code and puts the focus on the key that approves it", async () => {
    history.replaceState(null, "", "/device?user_code=abcd-efgh");
    captureDeviceLinkFromPage();
    expect(location.search).toBe("");
    show();

    const field = screen.getByLabelText<HTMLInputElement>("User code");
    expect(field.value).toBe("ABCD-EFGH");
    const go = screen.getByRole("button", { name: "Approve device" });
    await waitFor(() => expect(document.activeElement).toBe(go));

    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(approveDevice).toHaveBeenCalledWith("ABCD-EFGH"),
    );
    expect(
      await screen.findByRole("img", { name: "Device approved" }),
    ).toBeTruthy();
  });

  it("keeps the code across a remount until it is approved", async () => {
    history.replaceState(null, "", "/device?user_code=KEEP-0001");
    captureDeviceLinkFromPage();
    show().unmount();
    const again = show();
    const field = screen.getByLabelText<HTMLInputElement>("User code");
    expect(field.value).toBe("KEEP-0001");
    await userEvent.click(
      screen.getByRole("button", { name: "Approve device" }),
    );
    await screen.findByRole("img", { name: "Device approved" });
    again.unmount();
    show();
    expect(screen.getByLabelText<HTMLInputElement>("User code").value).toBe("");
  });

  it("reads a code an in-app navigation carried, and takes it out", async () => {
    history.replaceState(null, "", "/device?code=WXYZ-1234");
    show("/device?code=WXYZ-1234");
    expect(screen.getByLabelText<HTMLInputElement>("User code").value).toBe(
      "WXYZ-1234",
    );
    expect(location.search).toBe("");
  });

  it("opens on the field when no code arrived", async () => {
    show();
    const field = screen.getByLabelText("User code");
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(
      screen.getByRole("button", { name: "Approve device" }),
    ).toHaveProperty("disabled", true);
  });

  it("marks a refusal with the kit's words and puts them in the tray, not the page", async () => {
    approveDevice.mockRejectedValueOnce(
      new DirectoryError(
        404,
        "host_approval_failed",
        "No device is waiting on that code — check the code the device shows and try again.",
      ),
    );
    show();
    await userEvent.type(screen.getByLabelText("User code"), "NOPE");
    await userEvent.click(
      screen.getByRole("button", { name: "Approve device" }),
    );
    const mark = await screen.findByRole("img", {
      name: /No device is waiting on that code/,
    });
    expect(mark.className).toContain("status-mark--err");
    expect(trayed()?.body).toMatch(/No device is waiting on that code/);
    expect(document.querySelector(".note")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says a refused link was not used, and offers the field", async () => {
    history.replaceState(null, "", "/device?user_code=ABCD&access_token=x");
    captureDeviceLinkFromPage();
    show();
    expect(screen.getByLabelText<HTMLInputElement>("User code").value).toBe("");
    expect(trayed()?.tone).toBe("err");
    expect(approveDevice).not.toHaveBeenCalled();
  });

  it("asks for a session, and approves nothing, when none is held", () => {
    session.current = null;
    show();
    expect(screen.getByText("Connect to manage identities")).toBeTruthy();
    expect(screen.queryByLabelText("User code")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Connect" }),
    );
  });

  it("says a sign-in service is needed when none is configured", () => {
    deviceIdentitySeams.remoteIdentityApi = () => "";
    show();
    expect(screen.getByText("Connect a sign-in service")).toBeTruthy();
    expect(screen.queryByLabelText("User code")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByLabelText("Sign-in service"),
    );
  });
});
