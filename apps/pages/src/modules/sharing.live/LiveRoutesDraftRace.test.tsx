/** @vitest-environment jsdom */
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { LiveRoutesPanel } from "./LiveRoutesPanel.js";
import {
  currentTransport,
  holdNextWrite,
  type,
} from "./live-route-race.test-support.js";
import { transportSeams } from "./live-transport-hooks.js";

it("keeps the address draft and reports a refused save", async () => {
  transportSeams.edit = async () => {
    throw new Error("write failed");
  };
  const panel = within(render(<LiveRoutesPanel />).container);
  await panel.findByLabelText("Tailnet, VPN or LAN address");
  type(panel, "Tailnet, VPN or LAN address", "100.64.0.3");
  fireEvent.click(panel.getByRole("button", { name: "Add the address" }));
  await panel.findByRole("img", {
    name: "This vault could not keep the change",
  });
  expect(panel.getByLabelText("Tailnet, VPN or LAN address")).toHaveProperty(
    "value",
    "100.64.0.3",
  );
  expect(currentTransport().addresses).toEqual([]);
});

it("keeps a newer address typed while an earlier save is pending", async () => {
  const release = holdNextWrite();
  const panel = within(render(<LiveRoutesPanel />).container);
  await panel.findByLabelText("Tailnet, VPN or LAN address");
  type(panel, "Tailnet, VPN or LAN address", "100.64.0.1");
  fireEvent.click(panel.getByRole("button", { name: "Add the address" }));
  type(panel, "Tailnet, VPN or LAN address", "100.64.0.2");
  await release();
  expect(currentTransport().addresses).toEqual(["100.64.0.1"]);
  expect(panel.getByLabelText("Tailnet, VPN or LAN address")).toHaveProperty(
    "value",
    "100.64.0.2",
  );
  fireEvent.click(panel.getByRole("button", { name: "Add the address" }));
  await waitFor(() =>
    expect(currentTransport().addresses).toEqual(["100.64.0.1", "100.64.0.2"]),
  );
});

it("keeps newer TURN server and credentials while an earlier save is pending", async () => {
  const release = holdNextWrite();
  const panel = within(render(<LiveRoutesPanel />).container);
  await panel.findByLabelText("STUN or TURN server");
  type(panel, "STUN or TURN server", "turn:first.example.com");
  type(panel, "TURN username", "first-user");
  type(panel, "TURN credential", "first-secret");
  fireEvent.click(panel.getByRole("button", { name: "Add the server" }));
  type(panel, "STUN or TURN server", "turn:next.example.com");
  type(panel, "TURN username", "next-user");
  type(panel, "TURN credential", "next-secret");
  await release();
  expect(currentTransport().ice).toEqual([
    {
      urls: ["turn:first.example.com"],
      username: "first-user",
      credential: "first-secret",
    },
  ]);
  expect(panel.getByLabelText("STUN or TURN server")).toHaveProperty(
    "value",
    "turn:next.example.com",
  );
  expect(panel.getByLabelText("TURN username")).toHaveProperty(
    "value",
    "next-user",
  );
  expect(panel.getByLabelText("TURN credential")).toHaveProperty(
    "value",
    "next-secret",
  );
  fireEvent.click(panel.getByRole("button", { name: "Add the server" }));
  await waitFor(() => expect(currentTransport().ice).toHaveLength(2));
  expect(currentTransport().ice[1]).toEqual({
    urls: ["turn:next.example.com"],
    username: "next-user",
    credential: "next-secret",
  });
});

it("keeps a newer carrier draft and NATS choice while an earlier save is pending", async () => {
  const release = holdNextWrite();
  const panel = within(render(<LiveRoutesPanel />).container);
  await panel.findByLabelText("Code carrier");
  type(panel, "Server (https://)", "https://first.example.com");
  fireEvent.click(panel.getByRole("button", { name: "Add the carrier" }));
  fireEvent.change(panel.getByLabelText("Code carrier"), {
    target: { value: "nats" },
  });
  type(panel, "Server (wss://)", "wss://next.example.com");
  fireEvent.change(panel.getByLabelText("Session over this server"), {
    target: { value: "always" },
  });
  await release();
  expect(currentTransport().carriers).toEqual([
    { kind: "ntfy", url: "https://first.example.com" },
  ]);
  expect(panel.getByLabelText("Server (wss://)")).toHaveProperty(
    "value",
    "wss://next.example.com",
  );
  expect(panel.getByLabelText("Session over this server")).toHaveProperty(
    "value",
    "always",
  );
  fireEvent.click(panel.getByRole("button", { name: "Add the carrier" }));
  await waitFor(() => expect(currentTransport().carriers).toHaveLength(2));
  expect(currentTransport().carriers[1]).toEqual({
    kind: "nats",
    url: "wss://next.example.com",
    session: "always",
  });
});
