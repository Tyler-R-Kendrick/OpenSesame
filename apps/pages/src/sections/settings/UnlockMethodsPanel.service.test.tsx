/** @vitest-environment jsdom */
import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";
import {
  loadSettings,
  saveSettings,
} from "@opensesame/app-core/lib/settings.js";
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
  guestHeader,
  identityApi,
  installUnlockSeams,
  passwordOnlyHeader,
  row,
  sheet,
  vault,
} from "./unlock-methods-panel.test-support.js";

const restoreSeams = installUnlockSeams();
const realRemoteIdentityApi = deviceIdentitySeams.remoteIdentityApi;
afterAll(restoreSeams);

/** Sign-in service rows of Settings › Security: set, change, forget, and when absent. */
describe("UnlockMethodsPanel — sign-in service", () => {
  beforeEach(() => {
    passwordOnlyHeader();
    identityApi.current = "http://127.0.0.1:8788";
    window.history.replaceState(null, "", "/settings");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    deviceIdentitySeams.remoteIdentityApi = realRemoteIdentityApi;
  });

  it("with no sign-in service, the email and text keys set one — never a link away", async () => {
    identityApi.current = "";
    render(<UnlockMethodsPanel />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("img", { name: "Unavailable" })).toBeNull();
    expect(
      row("Email code").getByText("Needs a sign-in service to send it."),
    ).toBeTruthy();
    for (const name of ["Email code", "Text message"]) {
      const key = row(name).getByRole("button", {
        name: "Set sign-in service",
      });
      expect(key).toHaveProperty("disabled", false);
    }
    await userEvent.click(
      row("Text message").getByRole("button", { name: "Set sign-in service" }),
    );
    expect(
      sheet().getByText("Sign-in service", { selector: "h2" }),
    ).toBeTruthy();
  });

  it("saves the sign-in service from its sheet, then the rows can add a code", async () => {
    identityApi.current = "";
    // The seam reads the real setting so the write is what turns the rows on.
    deviceIdentitySeams.remoteIdentityApi = () =>
      loadSettings().identityApi.replace(/\/$/, "");
    const before = loadSettings();
    try {
      render(<UnlockMethodsPanel />);
      await userEvent.click(
        row("Sign-in service").getByRole("button", { name: "Add" }),
      );
      const dialog = sheet();
      const save = dialog.getByRole("button", { name: "Use this service" });
      expect(save).toHaveProperty("disabled", true);
      const field = dialog.getByLabelText("Sign-in service");
      await userEvent.type(field, "ftp://nope.example");
      expect(save).toHaveProperty("disabled", true);
      await userEvent.clear(field);
      await userEvent.type(field, "https://login.example.com/");
      expect(save).toHaveProperty("disabled", false);
      await userEvent.click(save);
      expect(loadSettings().identityApi).toBe("https://login.example.com");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(
        row("Email code").getByRole("button", { name: "Add" }),
      ).toBeTruthy();
      expect(
        row("Sign-in service").getByText(/login\.example\.com/),
      ).toBeTruthy();
    } finally {
      saveSettings(before);
    }
  });

  it("forgets the sign-in service after a confirmation card", async () => {
    deviceIdentitySeams.remoteIdentityApi = () =>
      loadSettings().identityApi.replace(/\/$/, "");
    const before = loadSettings();
    saveSettings({ ...before, identityApi: "https://login.example.com" });
    try {
      render(<UnlockMethodsPanel />);
      await userEvent.click(
        row("Sign-in service").getByRole("button", { name: "Remove" }),
      );
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(loadSettings().identityApi).toBe("https://login.example.com");
      await userEvent.click(
        sheet().getByRole("button", { name: "Forget service" }),
      );
      expect(loadSettings().identityApi).toBe("");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(
        row("Email code").getByRole("button", { name: "Set sign-in service" }),
      ).toBeTruthy();
    } finally {
      saveSettings(before);
    }
  });

  it("offers neither Change nor Remove on the service while an email code depends on it", () => {
    vault.current = {
      header: { wrap: {}, kdf: {}, unlocks: { email: {} } },
    };
    render(<UnlockMethodsPanel />);
    expect(
      row("Sign-in service").queryByRole("button", { name: "Change" }),
    ).toBeNull();
    expect(
      row("Sign-in service").queryByRole("button", { name: "Remove" }),
    ).toBeNull();
  });

  it("offers no email or text code on a keyless vault — it could not finish", () => {
    guestHeader();
    render(<UnlockMethodsPanel />);
    expect(
      screen.queryByText("Email code", { selector: ".sw__name" }),
    ).toBeNull();
    expect(
      screen.queryByText("Text message", { selector: ".sw__name" }),
    ).toBeNull();
    expect(
      screen.queryByText("Sign-in service", { selector: ".sw__name" }),
    ).toBeNull();
    // The authenticator still walks a key first.
    expect(
      row("Authenticator app").getByRole("button", { name: "Add" }),
    ).toHaveProperty("disabled", false);
  });
});
