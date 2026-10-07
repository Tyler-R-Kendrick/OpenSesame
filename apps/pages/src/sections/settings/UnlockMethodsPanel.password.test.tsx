/** @vitest-environment jsdom */
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
import { KeyCeremony } from "./security/KeyCeremony.js";
import {
  checkWebauthnHost,
  installUnlockSeams,
  passkeyOnlyHeader,
  passwordOnlyHeader,
  pinAndPasswordHeader,
  row,
  sheet,
  store,
  vault,
} from "./unlock-methods-panel.test-support.js";

const restoreSeams = installUnlockSeams();
afterAll(restoreSeams);

/**
 * A master password is never added or changed from Settings › Security (ADR
 * 0180); a vault that already holds one can only drop it, and only once
 * another key is in place.
 */
describe("UnlockMethodsPanel — the master password", () => {
  beforeEach(() => {
    passwordOnlyHeader();
    checkWebauthnHost.mockReturnValue({
      ok: true,
      hostname: "localhost",
      reason: "",
      fixUrl: null,
    });
    for (const fn of Object.values(store)) fn.mockReset();
    store.enrollPin.mockResolvedValue(undefined);
    store.removePassword.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("draws no password row at all on a vault that holds none", () => {
    passkeyOnlyHeader();
    render(<UnlockMethodsPanel />);
    expect(
      screen.queryByText("Password", { selector: ".sw__name" }),
    ).toBeNull();
    expect(row("Passkey").getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(row("PIN").getByRole("button", { name: "Add" })).toBeTruthy();
  });

  it("never offers a password as an alternative in any key sheet", async () => {
    passkeyOnlyHeader();
    render(<UnlockMethodsPanel />);
    await userEvent.click(row("PIN").getByRole("button", { name: "Add" }));
    const dialog = sheet();
    expect(dialog.queryByRole("button", { name: /password/i })).toBeNull();
    expect(dialog.queryByLabelText(/password/i)).toBeNull();
  });

  it("confirms a removal in the card and refuses to remove the last key", async () => {
    render(<UnlockMethodsPanel />);
    await userEvent.click(
      row("Password").getByRole("button", { name: "Remove" }),
    );
    const dialog = sheet();
    expect(document.querySelector(".found--ask .go")).toBeTruthy();
    expect(
      dialog.getByRole("button", { name: "Remove password" }),
    ).toHaveProperty("disabled", true);
    expect(dialog.getByText(/only key/)).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Add a passkey" })).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Add a PIN" })).toBeTruthy();
    await userEvent.click(dialog.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.removePassword).not.toHaveBeenCalled();
  });

  it("removes the password once another key exists", async () => {
    pinAndPasswordHeader();
    render(<UnlockMethodsPanel />);
    await userEvent.click(
      row("Password").getByRole("button", { name: "Remove" }),
    );
    const dialog = sheet();
    await userEvent.click(
      dialog.getByRole("button", { name: "Remove password" }),
    );
    await waitFor(() => expect(store.removePassword).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says a saved reminder shows at unlock on the row that holds the password", () => {
    vault.current = {
      header: { wrap: {}, kdf: {}, unlocks: {}, hint: "my usual place" },
    };
    render(<UnlockMethodsPanel />);
    expect(
      row("Password").getByText("The reminder you saved shows at unlock."),
    ).toBeTruthy();
  });

  it("draws no password form even if a sheet is asked for one", () => {
    render(
      <KeyCeremony
        kind="password"
        view="add"
        enrolled={["passkey"]}
        host={{ ok: true, hostname: "localhost", reason: "", fixUrl: null }}
        busy={false}
        run={async () => {}}
        onDone={() => {}}
      />,
    );
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /set password/i })).toBeNull();
  });
});
