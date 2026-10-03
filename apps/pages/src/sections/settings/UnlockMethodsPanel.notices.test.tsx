/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
 * What an action did shows where it can be read: a success is the row's own
 * mark and is only announced, a failure is a notice in the tray — never a box
 * in the page behind the sheet that asked (DESIGN.md).
 */
describe("UnlockMethodsPanel outcomes", () => {
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
    store.enrollPin.mockResolvedValue(undefined);
    clearNotices();
    window.history.replaceState(null, "", "/settings");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  async function setPin() {
    render(<UnlockMethodsPanel />);
    await userEvent.click(row("PIN").getByRole("button", { name: "Add" }));
    const dialog = sheet();
    await userEvent.type(dialog.getByLabelText("PIN"), "48291037");
    await userEvent.type(dialog.getByLabelText("Confirm PIN"), "48291037");
    await userEvent.click(dialog.getByRole("button", { name: "Set PIN" }));
  }

  it("announces a success and draws no box: the row's mark is the state", async () => {
    await setPin();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // A box that outlived the header it described once claimed a PIN that
    // was gone.
    const said = await screen.findByText(/PIN unlock enrolled/);
    expect(said.closest("output")?.className).toContain("visually-hidden");
    expect(document.querySelector(".note")).toBeNull();
  });

  it("reports a failed enrollment as a tray notice, not a box in the page", async () => {
    store.enrollPin.mockRejectedValueOnce(new Error("The device refused."));
    await setPin();
    await waitFor(() =>
      expect(
        listNotices().find((notice) => notice.id === "unlock-methods")?.body,
      ).toContain("The device refused."),
    );
    expect(document.querySelector(".note")).toBeNull();
  });
});
