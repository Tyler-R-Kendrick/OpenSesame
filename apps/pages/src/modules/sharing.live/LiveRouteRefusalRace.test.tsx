/** @vitest-environment jsdom */
import { fireEvent, render, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { LiveRoutesPanel } from "./LiveRoutesPanel.js";
import {
  currentTransport,
  holdNextRefusal,
  type,
} from "./live-route-race.test-support.js";

it("clears untouched TURN credentials after a refused save with a changed destination", async () => {
  const release = holdNextRefusal();
  const panel = within(render(<LiveRoutesPanel />).container);
  await panel.findByLabelText("STUN or TURN server");
  type(panel, "STUN or TURN server", "turn:first.example.com");
  type(panel, "TURN username", "first-user");
  type(panel, "TURN credential", "first-secret");
  fireEvent.click(panel.getByRole("button", { name: "Add the server" }));
  type(panel, "STUN or TURN server", "turn:next.example.com");
  await release();
  await panel.findByRole("img", {
    name: "This vault could not keep the change",
  });
  expect(panel.getByLabelText("STUN or TURN server")).toHaveProperty(
    "value",
    "turn:next.example.com",
  );
  expect(panel.getByLabelText("TURN username")).toHaveProperty("value", "");
  expect(panel.getByLabelText("TURN credential")).toHaveProperty("value", "");
  expect(panel.getByRole("button", { name: "Add the server" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(currentTransport().ice).toHaveLength(0);
});

it("keeps a deliberately edited TURN credential after a refused save to a changed destination", async () => {
  const release = holdNextRefusal();
  const panel = within(render(<LiveRoutesPanel />).container);
  await panel.findByLabelText("STUN or TURN server");
  type(panel, "STUN or TURN server", "turn:first.example.com");
  type(panel, "TURN username", "first-user");
  type(panel, "TURN credential", "first-secret");
  fireEvent.click(panel.getByRole("button", { name: "Add the server" }));
  type(panel, "STUN or TURN server", "turn:next.example.com");
  type(panel, "TURN credential", "next-secret");
  await release();
  await panel.findByRole("img", {
    name: "This vault could not keep the change",
  });
  expect(panel.getByLabelText("STUN or TURN server")).toHaveProperty(
    "value",
    "turn:next.example.com",
  );
  expect(panel.getByLabelText("TURN username")).toHaveProperty("value", "");
  expect(panel.getByLabelText("TURN credential")).toHaveProperty(
    "value",
    "next-secret",
  );
  expect(panel.getByRole("button", { name: "Add the server" })).toHaveProperty(
    "disabled",
    true,
  );
});

it("clears untouched NATS credentials after a refused save with a changed destination", async () => {
  const release = holdNextRefusal();
  const panel = within(render(<LiveRoutesPanel />).container);
  await panel.findByLabelText("Code carrier");
  type(panel, "Code carrier", "nats");
  type(panel, "Server (wss://)", "wss://first.example.com");
  type(panel, "Sign-in", "mint");
  type(panel, "Account public key", `A${"B".repeat(55)}`);
  type(panel, "Account signing key", `SA${"C".repeat(56)}`);
  fireEvent.click(panel.getByRole("button", { name: "Add the carrier" }));
  type(panel, "Server (wss://)", "wss://next.example.com");
  await release();
  await panel.findByRole("img", {
    name: "This vault could not keep the change",
  });
  expect(panel.getByLabelText("Server (wss://)")).toHaveProperty(
    "value",
    "wss://next.example.com",
  );
  expect(panel.getByLabelText("Sign-in")).toHaveProperty("value", "none");
  type(panel, "Sign-in", "mint");
  expect(panel.getByLabelText("Account public key")).toHaveProperty(
    "value",
    "",
  );
  expect(panel.getByLabelText("Account signing key")).toHaveProperty(
    "value",
    "",
  );
  expect(panel.getByRole("button", { name: "Add the carrier" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(currentTransport().carriers).toHaveLength(0);
});

it("keeps a deliberately edited NATS key after a refused save to a changed destination", async () => {
  const release = holdNextRefusal();
  const panel = within(render(<LiveRoutesPanel />).container);
  await panel.findByLabelText("Code carrier");
  const key = `SA${"D".repeat(56)}`;
  type(panel, "Code carrier", "nats");
  type(panel, "Server (wss://)", "wss://first.example.com");
  type(panel, "Sign-in", "mint");
  type(panel, "Account public key", `A${"B".repeat(55)}`);
  type(panel, "Account signing key", `SA${"C".repeat(56)}`);
  fireEvent.click(panel.getByRole("button", { name: "Add the carrier" }));
  type(panel, "Server (wss://)", "wss://next.example.com");
  type(panel, "Account signing key", key);
  await release();
  await panel.findByRole("img", {
    name: "This vault could not keep the change",
  });
  expect(panel.getByLabelText("Server (wss://)")).toHaveProperty(
    "value",
    "wss://next.example.com",
  );
  expect(panel.getByLabelText("Sign-in")).toHaveProperty("value", "mint");
  expect(panel.getByLabelText("Account public key")).toHaveProperty(
    "value",
    "",
  );
  expect(panel.getByLabelText("Account signing key")).toHaveProperty(
    "value",
    key,
  );
  expect(panel.getByRole("button", { name: "Add the carrier" })).toHaveProperty(
    "disabled",
    true,
  );
});

it("clears an untouched NATS secret when a refused save is followed by a carrier-kind change", async () => {
  const release = holdNextRefusal();
  const panel = within(render(<LiveRoutesPanel />).container);
  await panel.findByLabelText("Code carrier");
  type(panel, "Code carrier", "nats");
  type(panel, "Server (wss://)", "wss://first.example.com");
  type(panel, "Sign-in", "mint");
  type(panel, "Account public key", `A${"B".repeat(55)}`);
  type(panel, "Account signing key", `SA${"C".repeat(56)}`);
  fireEvent.click(panel.getByRole("button", { name: "Add the carrier" }));
  type(panel, "Code carrier", "mqtt");
  await release();
  await panel.findByRole("img", {
    name: "This vault could not keep the change",
  });
  expect(panel.getByLabelText("Server (wss://)")).toHaveProperty("value", "");
  type(panel, "Code carrier", "nats");
  expect(panel.getByLabelText("Sign-in")).toHaveProperty("value", "none");
  type(panel, "Sign-in", "mint");
  expect(panel.getByLabelText("Account public key")).toHaveProperty(
    "value",
    "",
  );
  expect(panel.getByLabelText("Account signing key")).toHaveProperty(
    "value",
    "",
  );
  expect(currentTransport().carriers).toHaveLength(0);
});
