import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/use-online.js", () => ({
  useOnline: () => true,
}));

vi.mock("../../lib/planes.js", () => ({
  usePlaneStatus: () => ({ host: "live", identity: "live" }),
}));

const ensureHostSession = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

const session = vi.hoisted(() => ({ principalId: "prn_op" }));

vi.mock("../../lib/identity.js", () => ({
  useIdentitySession: () => session,
  hostLocalSessionEligible: () => true,
  ensureHostSession,
}));

const getTaskBusConfig = vi.hoisted(() => vi.fn());
const putTaskBusConfig = vi.hoisted(() => vi.fn());
const pingTaskBus = vi.hoisted(() => vi.fn());

vi.mock("../../lib/taskbus.js", () => ({
  getTaskBusConfig,
  putTaskBusConfig,
  pingTaskBus,
}));

import { TaskBusPanel } from "./TaskBusPanel.js";

describe("TaskBusPanel render", () => {
  beforeEach(() => {
    ensureHostSession.mockResolvedValue(undefined);
    getTaskBusConfig.mockResolvedValue({
      backend: "memory",
      natsUrl: null,
      source: "stored",
      status: "ok",
      lastError: null,
    });
    putTaskBusConfig.mockResolvedValue({
      applied: true,
      config: {
        backend: "nats",
        natsUrl: "nats://127.0.0.1:4222",
        source: "stored",
        status: "applied",
        lastError: null,
      },
    });
    pingTaskBus.mockResolvedValue({
      ok: true,
      config: {
        backend: "nats",
        natsUrl: "nats://127.0.0.1:4222",
        source: "stored",
        status: "reachable",
        lastError: null,
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  async function waitForConfigLoaded() {
    await screen.findByText(/source/, {}, { timeout: 3000 });
  }

  it("renders Host proxy controls and never mentions browser NATS dial", async () => {
    render(<TaskBusPanel />);
    expect(
      await screen.findByRole("heading", { name: /TaskBus \/ NATS/i }),
    ).toBeTruthy();
    expect(screen.getByText(/This browser never opens NATS/i)).toBeTruthy();
    await waitForConfigLoaded();
    expect(getTaskBusConfig).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Save$/i })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Ping from Host/i }),
    ).toBeTruthy();
  });

  it("saves selected nats backend through putTaskBusConfig", async () => {
    getTaskBusConfig.mockResolvedValue({
      backend: "nats",
      natsUrl: "nats://127.0.0.1:4222",
      source: "stored",
      status: "ok",
      lastError: null,
    });
    render(<TaskBusPanel />);
    await waitForConfigLoaded();
    expect(
      await screen.findByPlaceholderText("nats://127.0.0.1:4222"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/applied/i);
    expect(putTaskBusConfig).toHaveBeenCalledWith({
      backend: "nats",
      natsUrl: "nats://127.0.0.1:4222",
    });
  });

  it("pings Host and surfaces reachable status", async () => {
    const user = userEvent.setup();
    render(<TaskBusPanel />);
    await waitForConfigLoaded();
    await user.click(screen.getByRole("button", { name: /Ping from Host/i }));
    await waitFor(() => expect(pingTaskBus).toHaveBeenCalled());
    expect(screen.getByRole("status").textContent).toMatch(
      /Host reached TaskBus/i,
    );
  });

  it("shows env override notice and disables save controls", async () => {
    getTaskBusConfig.mockResolvedValue({
      backend: "memory",
      natsUrl: null,
      source: "env",
      status: "env_override",
      lastError: null,
    });
    render(<TaskBusPanel />);
    await waitFor(() => {
      expect(screen.getByText(/OPENSESAME_TASKBUS/i)).toBeTruthy();
    });
    expect(
      (screen.getByRole("button", { name: /^Save$/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
