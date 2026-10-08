/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetiredCredentialRow } from "./RetiredCredentialRow.js";

import type { retiredCredentialStatus } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { retiredCredentialUiPorts } from "./retired-credential-ports.js";

const originalPorts = { ...retiredCredentialUiPorts };
const originalHooks = { ...vaultHooksSeams };
function emptyStatus(): ReturnType<typeof retiredCredentialStatus> {
  return { durable: true, traps: [], events: [] };
}
type OwnerSession = Pick<
  ReturnType<typeof vaultStore.getSnapshot>,
  "tomb" | "guest" | "decoy" | "awaitingSecondStep" | "status"
>;
const session = (): OwnerSession => ({
  tomb: "personal",
  guest: false,
  decoy: false,
  awaitingSecondStep: false,
  status: "unlocked",
});
const seams = {
  session: session(),
  status: emptyStatus(),
  enroll: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn(),
  broken: false,
  supported: true,
  refresh: vi.fn<() => Promise<ReturnType<typeof retiredCredentialStatus>>>(),
};
function input(label: string): HTMLInputElement {
  const node = screen.getByLabelText(label);
  if (!(node instanceof HTMLInputElement))
    throw new Error("Expected a password input.");
  return node;
}
async function open() {
  await userEvent.click(
    screen.getByRole("button", { name: "Manage retired passwords" }),
  );
}
function current(value = "current-secret") {
  fireEvent.change(screen.getByLabelText("Current vault password"), {
    target: { value },
  });
}
function fill() {
  current();
  fireEvent.change(screen.getByLabelText("Selected retired password"), {
    target: { value: "retired-secret" },
  });
}

describe("Retired passwords owner sheet", () => {
  beforeEach(() => {
    seams.session = {
      tomb: "personal",
      guest: false,
      decoy: false,
      awaitingSecondStep: false,
      status: "unlocked",
    };
    seams.status = { durable: true, traps: [], events: [] };
    seams.broken = false;
    seams.supported = true;
    Object.assign(vaultHooksSeams, {
      useVault: () => ({ ...vaultStore.getSnapshot(), ...seams.session }),
    });
    Object.assign(retiredCredentialUiPorts, {
      retiredCredentialStatus: () => {
        if (seams.broken) throw new Error("bad record");
        return seams.status;
      },
      retiredCredentialEnrollmentSupported: () => seams.supported,
      refreshStatus: seams.refresh,
      enrollRetiredCredential: seams.enroll,
      removeRetiredCredential: seams.remove,
      clearRetiredCredentialEvents: seams.clear,
    });
    vi.clearAllMocks();
    seams.refresh.mockImplementation(async () => seams.status);
    seams.enroll.mockResolvedValue(undefined);
    seams.remove.mockResolvedValue(undefined);
    seams.clear.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    Object.assign(vaultHooksSeams, originalHooks);
    Object.assign(retiredCredentialUiPorts, originalPorts);
  });
  it("is absent for guests, decoys, and locked sessions", () => {
    for (const session of [
      {
        guest: true,
        decoy: false,
        awaitingSecondStep: false,
        status: "unlocked",
      },
      {
        guest: false,
        decoy: true,
        awaitingSecondStep: false,
        status: "unlocked",
      },
      {
        guest: false,
        decoy: false,
        awaitingSecondStep: true,
        status: "unlocked",
      },
      {
        guest: false,
        decoy: false,
        awaitingSecondStep: false,
        status: "locked",
      },
    ]) {
      Object.assign(seams.session, session);
      const result = render(<RetiredCredentialRow />);
      expect(result.container.innerHTML).toBe("");
      result.unmount();
    }
  });
  it("requires risk acknowledgement and defaults to record-and-reject", async () => {
    render(<RetiredCredentialRow />);
    await open();
    fill();
    const enroll = screen.getByRole("button", {
      name: "Enroll retired password",
    });
    expect(enroll.hasAttribute("disabled")).toBe(true);
    expect(input("Record and reject").checked).toBe(true);
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(enroll);
    await waitFor(() =>
      expect(seams.enroll).toHaveBeenCalledWith({
        tomb: "personal",
        currentPassword: "current-secret",
        retiredPassword: "retired-secret",
        response: "reject",
        acknowledgePasswordVerifierRisk: true,
      }),
    );
    expect(input("Current vault password").value).toBe("");
    expect(input("Selected retired password").value).toBe("");
  });
  it("offers only a synthetic decoy as the alternate response", async () => {
    render(<RetiredCredentialRow />);
    await open();
    fill();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    await userEvent.click(
      screen.getByRole("radio", { name: "Open a synthetic decoy" }),
    );
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(
      screen.getByRole("button", { name: "Enroll retired password" }),
    );
    await waitFor(() =>
      expect(seams.enroll.mock.calls[0]?.[0].response).toBe("synthetic_decoy"),
    );
  });
  it("requires fresh authentication to remove traps and clear observations", async () => {
    seams.status.traps = [
      { id: "trap-1", createdAt: "2026-10-05", response: "reject" },
    ];
    seams.status.events = [
      {
        type: "retired_credential_observed",
        trapId: "trap-1",
        at: "2026-10-05",
        response: "reject",
      },
    ];
    render(<RetiredCredentialRow />);
    await open();
    const remove = screen.getByRole("button", {
      name: "Remove retired password 1",
    });
    const clear = screen.getByRole("button", {
      name: "Clear local observations",
    });
    expect(remove.hasAttribute("disabled")).toBe(true);
    expect(clear.hasAttribute("disabled")).toBe(true);
    current("fresh");
    await userEvent.click(remove);
    await waitFor(() =>
      expect(seams.remove).toHaveBeenCalledWith({
        tomb: "personal",
        currentPassword: "fresh",
        id: "trap-1",
      }),
    );
    expect(clear.hasAttribute("disabled")).toBe(true);
    current("fresh-again");
    await userEvent.click(clear);
    await waitFor(() =>
      expect(seams.clear).toHaveBeenCalledWith({
        tomb: "personal",
        currentPassword: "fresh-again",
      }),
    );
  });
  it("renders bounded synthetic interaction labels without evidence identifiers", async () => {
    seams.status.events = [
      {
        type: "synthetic_decoy_interaction",
        response: "synthetic_decoy",
        trapId: "private-trap-id",
        at: "2026-10-05",
        action: "vault_write",
      },
      {
        type: "synthetic_decoy_interaction",
        response: "synthetic_decoy",
        trapId: "private-trap-id",
        at: "2026-10-05",
        action: "authority_denied",
      },
    ];
    const result = render(<RetiredCredentialRow />);
    await open();
    expect(screen.getByText(/Synthetic decoy changed/)).toBeTruthy();
    expect(screen.getByText(/External authority denied/)).toBeTruthy();
    expect(result.container.textContent).not.toContain("private-trap-id");
  });
  it("refreshes durable observations before opening an already-open owner's sheet", async () => {
    render(<RetiredCredentialRow />);
    seams.refresh.mockResolvedValue({
      ...emptyStatus(),
      events: [
        {
          type: "retired_credential_observed",
          trapId: "remote-trap",
          at: "2026-10-05",
          response: "reject",
        },
      ],
    });
    await open();
    await waitFor(() =>
      expect(screen.getByText(/Retired password observed/)).toBeTruthy(),
    );
    expect(seams.refresh).toHaveBeenCalledTimes(1);
  });
  it("does not reopen a sheet when an async refresh outlives its owner session", async () => {
    let release: (status: ReturnType<typeof retiredCredentialStatus>) => void =
      () => {};
    seams.refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const result = render(<RetiredCredentialRow />);
    await open();
    seams.session.status = "locked";
    result.rerender(<RetiredCredentialRow />);
    seams.session.status = "unlocked";
    result.rerender(<RetiredCredentialRow />);
    release(emptyStatus());
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Manage retired passwords" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("refuses management of corrupt records", () => {
    seams.broken = true;
    render(<RetiredCredentialRow />);
    expect(
      screen
        .getByRole("button", { name: "Manage retired passwords" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByRole("img", { name: "Unavailable" })).toBeTruthy();
  });
  it("hides unsupported enrollment and keeps existing evidence read-only", async () => {
    seams.supported = false;
    const result = render(<RetiredCredentialRow />);
    expect(result.container.innerHTML).toBe("");
    seams.status.traps = [
      { id: "trap", createdAt: "2026-10-05", response: "reject" },
    ];
    result.rerender(<RetiredCredentialRow />);
    await open();
    expect(
      screen
        .getByRole("button", { name: "Enroll retired password" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Remove retired password 1" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
  it("bounds enrollment to three explicitly selected passwords", async () => {
    seams.status.traps = Array.from({ length: 3 }, (_, index) => ({
      id: String(index),
      createdAt: "2026-10-05",
      response: "reject" as const,
    }));
    render(<RetiredCredentialRow />);
    await open();
    fill();
    await userEvent.click(screen.getByRole("checkbox"));
    expect(
      screen
        .getByRole("button", { name: "Enroll retired password" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(seams.enroll).not.toHaveBeenCalled();
  });
  it("closes the sheet when the owner locks", async () => {
    const result = render(<RetiredCredentialRow />);
    await open();
    seams.session.status = "locked";
    result.rerender(<RetiredCredentialRow />);
    expect(screen.queryByRole("dialog")).toBeNull();
    seams.session.status = "unlocked";
    result.rerender(<RetiredCredentialRow />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
