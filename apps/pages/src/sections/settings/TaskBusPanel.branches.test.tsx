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

const online = vi.hoisted(() => ({ value: true }));
const planes = vi.hoisted(() => ({
  value: { host: "live", identity: "live" },
}));

vi.mock("../../lib/use-online.js", () => ({
  useOnline: () => online.value,
}));

vi.mock("../../lib/planes.js", () => ({
  usePlaneStatus: () => planes.value,
}));

const ensureHostSession = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

vi.mock("../../lib/identity.js", () => ({
  useIdentitySession: () => ({ principalId: "prn_op" }),
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

const memoryConfig = {
  backend: "memory",
  natsUrl: null,
  source: "stored",
  status: "ok",
  lastError: null,
};

describe("TaskBusPanel edges", () => {
  beforeEach(() => {
    online.value = true;
    planes.value = { host: "live", identity: "live" };
    getTaskBusConfig.mockResolvedValue({ ...memoryConfig });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("asks for connectivity while offline", () => {
    online.value = false;
    render(<TaskBusPanel />);
    expect(
      screen.getByText(/Connect to the network to configure TaskBus/),
    ).toBeTruthy();
    expect(getTaskBusConfig).not.toHaveBeenCalled();
  });

  it("asks for a reachable Host before configuring", () => {
    planes.value = { host: "degraded", identity: "live" };
    render(<TaskBusPanel />);
    expect(
      screen.getByText(/Host API is not reachable\. Pair or start Host first/),
    ).toBeTruthy();
  });

  it("surfaces config load failures", async () => {
    getTaskBusConfig.mockRejectedValue(new Error("host refused"));
    render(<TaskBusPanel />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/host refused/);
  });

  it("uses a generic message for non-Error load failures", async () => {
    getTaskBusConfig.mockRejectedValue("boom");
    render(<TaskBusPanel />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Could not load TaskBus config/);
  });

  it("shows the NATS URL field only for the nats backend", async () => {
    render(<TaskBusPanel />);
    await screen.findByText(/source/);
    const select = screen.getByLabelText(/Backend/i);
    // memory default → no URL field.
    expect(screen.queryByPlaceholderText("nats://127.0.0.1:4222")).toBeNull();
    fireEvent.change(select, { target: { value: "nats" } });
    expect((select as HTMLSelectElement).value).toBe("nats");
    expect(screen.getByPlaceholderText("nats://127.0.0.1:4222")).toBeTruthy();
    fireEvent.change(select, { target: { value: "memory" } });
    expect(screen.queryByPlaceholderText("nats://127.0.0.1:4222")).toBeNull();
  });

  it("saves the memory backend without a URL", async () => {
    putTaskBusConfig.mockResolvedValue({
      applied: true,
      config: { ...memoryConfig },
    });
    render(<TaskBusPanel />);
    await screen.findByText(/source/);
    await userEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    await waitFor(() =>
      expect(putTaskBusConfig).toHaveBeenCalledWith({
        backend: "memory",
        natsUrl: undefined,
      }),
    );
  });

  it("surfaces save failures", async () => {
    putTaskBusConfig.mockRejectedValue(new Error("write failed"));
    render(<TaskBusPanel />);
    await screen.findByText(/source/);
    await userEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/write failed/);
  });

  it("surfaces ping failures", async () => {
    pingTaskBus.mockRejectedValue(new Error("nats down"));
    render(<TaskBusPanel />);
    await screen.findByText(/source/);
    await userEvent.click(
      screen.getByRole("button", { name: /Ping from Host/i }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/nats down/);
  });

  it("reports a failed ping outcome", async () => {
    pingTaskBus.mockResolvedValue({
      ok: false,
      config: {
        backend: "nats",
        natsUrl: "nats://127.0.0.1:4222",
        source: "stored",
        status: "unreachable",
        lastError: "connection refused",
      },
    });
    render(<TaskBusPanel />);
    await screen.findByText(/source/);
    await userEvent.click(
      screen.getByRole("button", { name: /Ping from Host/i }),
    );
    await waitFor(() => expect(pingTaskBus).toHaveBeenCalled());
    // The error detail from the host lands in the status line.
    expect(screen.getByText(/connection refused/)).toBeTruthy();
  });
});
