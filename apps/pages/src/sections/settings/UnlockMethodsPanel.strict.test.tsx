/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { UnlockMethodsPanel } from "./UnlockMethodsPanel.js";
import {
  checkWebauthnHost,
  identityApi,
  installUnlockSeams,
  passwordOnlyHeader,
  row,
  sheet,
  store,
} from "./unlock-methods-panel.test-support.js";

const restoreSeams = installUnlockSeams();
afterAll(restoreSeams);

/**
 * `main.tsx` renders under StrictMode, so a dev session mounts every effect,
 * cleans it up and mounts it again before a person sees anything. An
 * enrollment the sheet began in the first mount and cancelled in the cleanup
 * must be begun again by the second: the authenticator the person scans has
 * to be the one the store will check.
 */
describe("the authenticator ceremony under StrictMode", () => {
  let pending: string | null = null;
  let begun = 0;

  beforeEach(() => {
    passwordOnlyHeader();
    identityApi.current = "http://127.0.0.1:8788";
    checkWebauthnHost.mockReturnValue({
      ok: true,
      hostname: "localhost",
      reason: "",
      fixUrl: null,
    });
    for (const fn of Object.values(store)) fn.mockReset();
    pending = null;
    begun = 0;
    store.beginTotpEnrollment.mockImplementation(async () => {
      begun += 1;
      pending = `SEED${begun}`;
      return `otpauth://totp/vault?secret=${pending}`;
    });
    store.cancelTotpEnrollment.mockImplementation(() => {
      pending = null;
    });
    store.confirmTotpEnrollment.mockImplementation(async () => {
      if (pending === null)
        throw new Error("Start authenticator enrollment first.");
      pending = null;
    });
    store.recoveryCodes.mockResolvedValue(null);
    store.generateRecoveryCodes.mockResolvedValue(["aaaa-bbbb"]);
    window.history.replaceState(null, "", "/settings");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the seed the store holds, so the first matching code turns it on", async () => {
    render(
      <StrictMode>
        <UnlockMethodsPanel />
      </StrictMode>,
    );
    await userEvent.click(
      row("Authenticator app").getByRole("button", { name: "Add" }),
    );
    const dialog = sheet();
    const qr = await dialog.findByTestId("qr");
    await waitFor(() => expect(pending).not.toBeNull());
    expect(qr.textContent).toContain(`secret=${pending}`);
    await userEvent.click(dialog.getByRole("button", { name: "I scanned it" }));
    await userEvent.type(dialog.getByLabelText("Six digits"), "123456");
    await userEvent.click(dialog.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(dialog.getByText("aaaa-bbbb")).toBeTruthy());
    expect(
      screen.queryByText("Start authenticator enrollment first."),
    ).toBeNull();
  });
});
