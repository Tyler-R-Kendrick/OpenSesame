/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import ReceiverCeremony, { receiverUiPorts } from "./ReceiverCeremony.js";
const original = { ...receiverUiPorts };
afterEach(() => {
  cleanup();
  Object.assign(receiverUiPorts, original);
});
it("keeps receiver enable disabled until a genuine delivery acknowledgement has been verified", async () => {
  const api = await original.load();
  receiverUiPorts.requireOwner = () => {};
  receiverUiPorts.load = async () => ({
    ...api,
    getObservationReceiverStatus: async () => ({
      configured: true,
      receiverId: "owner-receiver",
      origin: "https://receiver.example",
      enabled: false,
      verified: false,
      queued: 0,
      failed: 0,
      durable: true,
    }),
  });
  render(<ReceiverCeremony tomb="personal" supported />);
  await waitFor(() =>
    expect(screen.getByText("https://receiver.example")).toBeTruthy(),
  );
  fireEvent.change(screen.getByLabelText("Current vault password"), {
    target: { value: "fresh-owner-password" },
  });
  expect(
    screen
      .getByRole("button", { name: "Enable observation receiver" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.queryByText("independentKeyMaterialB64")).toBeNull();
});
it("does not display receiver destination after authority changes during initial read", async () => {
  const api = await original.load();
  let owner = true;
  receiverUiPorts.requireOwner = () => {
    if (!owner) throw new Error("Locked owner");
  };
  receiverUiPorts.load = async () => ({
    ...api,
    getObservationReceiverStatus: async () => {
      owner = false;
      return {
        configured: true,
        receiverId: "owner-receiver",
        origin: "https://private-receiver.example",
        enabled: false,
        verified: false,
        queued: 0,
        failed: 0,
        durable: true,
      };
    },
  });
  render(<ReceiverCeremony tomb="personal" supported />);
  await waitFor(() =>
    expect(screen.getByText("Receiver records are unavailable.")).toBeTruthy(),
  );
  expect(screen.queryByText("https://private-receiver.example")).toBeNull();
});
