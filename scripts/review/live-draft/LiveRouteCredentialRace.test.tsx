/** @vitest-environment jsdom */
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { LiveRoutesPanel } from "./LiveRoutesPanel.js";
import {
  currentTransport,
  holdNextWrite,
  type,
} from "./live-route-race.test-support.js";
import { transportSeams } from "./live-transport-hooks.js";

it("clears submitted TURN credentials when only the destination changes", async () => {
  const release = holdNextWrite();
  const panel = within(render(<LiveRoutesPanel />).container);
  await panel.findByLabelText("STUN or TURN server");
  type(panel, "STUN or TURN server", "turn:first.example.com");
  type(panel, "TURN username", "first-user");
  type(panel, "TURN credential", "first-secret");
  fireEvent.click(panel.getByRole("button", { name: "Add the server" }));
  type(panel, "STUN or TURN server", "turn:next.example.com");
  await release();
  expect(currentTransport().ice).toHaveLength(1);
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
});

it("retains a TURN credential deliberately edited back to its submitted value", async () => {
  const release = holdNextWrite();
  const panel = within(render(<LiveRoutesPanel />).container);
  await panel.findByLabelText("STUN or TURN server");
  type(panel, "STUN or TURN server", "turn:first.example.com");
  type(panel, "TURN username", "first-user");
  type(panel, "TURN credential", "first-secret");
  fireEvent.click(panel.getByRole("button", { name: "Add the server" }));
  type(panel, "STUN or TURN server", "turn:next.example.com");
  type(panel, "TURN credential", "other-secret");
  type(panel, "TURN credential", "first-secret");
  await release();
  expect(panel.getByLabelText("STUN or TURN server")).toHaveProperty(
    "value",
    "turn:next.example.com",
  );
  expect(panel.getByLabelText("TURN username")).toHaveProperty("value", "");
  expect(panel.getByLabelText("TURN credential")).toHaveProperty(
    "value",
    "first-secret",
  );
  expect(panel.getByRole("button", { name: "Add the server" })).toHaveProperty(
    "disabled",
    true,
  );
});

it("clears submitted NATS credentials when only the destination changes", async () => {
  const release = holdNextWrite();
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
  expect(currentTransport().carriers).toHaveLength(1);
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
});

it("retains a NATS signing key deliberately edited back to its submitted value", async () => {
  const release = holdNextWrite();
  const panel = within(render(<LiveRoutesPanel />).container);
  await panel.findByLabelText("Code carrier");
  const key = `SA${"C".repeat(56)}`;
  type(panel, "Code carrier", "nats");
  type(panel, "Server (wss://)", "wss://first.example.com");
  type(panel, "Sign-in", "mint");
  type(panel, "Account public key", `A${"B".repeat(55)}`);
  type(panel, "Account signing key", key);
  fireEvent.click(panel.getByRole("button", { name: "Add the carrier" }));
  type(panel, "Server (wss://)", "wss://next.example.com");
  type(panel, "Account signing key", `SA${"D".repeat(56)}`);
  type(panel, "Account signing key", key);
  await release();
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

it("refuses a second TURN submit until the first save clears its old credentials", async () => {
  const release = holdNextWrite();
  const edit = vi.fn(transportSeams.edit);
  transportSeams.edit = edit;
  const panel = within(render(<LiveRoutesPanel />).container);
  await panel.findByLabelText("STUN or TURN server");
  type(panel, "STUN or TURN server", "turn:first.example.com");
  type(panel, "TURN username", "first-user");
  type(panel, "TURN credential", "first-secret");
  const button = panel.getByRole("button", { name: "Add the server" });
  fireEvent.click(button);
  type(panel, "STUN or TURN server", "turn:next.example.com");
  expect(button).toHaveProperty("disabled", true);
  // Exercise the synchronous form guard too; a disabled button is not the
  // only possible way for a submit event to arrive.
  const form = button.closest("form");
  if (!form) throw new Error("Expected the carrier or server form");
  fireEvent.submit(form);
  await waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
  await release();
  expect(currentTransport().ice).toHaveLength(1);
  expect(panel.getByLabelText("TURN username")).toHaveProperty("value", "");
  expect(panel.getByLabelText("TURN credential")).toHaveProperty("value", "");
  expect(button).toHaveProperty("disabled", true);
  type(panel, "TURN username", "next-user");
  type(panel, "TURN credential", "next-secret");
  fireEvent.click(button);
  await waitFor(() => expect(currentTransport().ice).toHaveLength(2));
  expect(currentTransport().ice[1]).toEqual({
    urls: ["turn:next.example.com"],
    username: "next-user",
    credential: "next-secret",
  });
});

it("refuses a second NATS submit until the first save clears its old signing key", async () => {
  const release = holdNextWrite();
  const edit = vi.fn(transportSeams.edit);
  transportSeams.edit = edit;
  const panel = within(render(<LiveRoutesPanel />).container);
  await panel.findByLabelText("Code carrier");
  type(panel, "Code carrier", "nats");
  type(panel, "Server (wss://)", "wss://first.example.com");
  type(panel, "Sign-in", "mint");
  type(panel, "Account public key", `A${"B".repeat(55)}`);
  type(panel, "Account signing key", `SA${"C".repeat(56)}`);
  const button = panel.getByRole("button", { name: "Add the carrier" });
  fireEvent.click(button);
  type(panel, "Server (wss://)", "wss://next.example.com");
  expect(button).toHaveProperty("disabled", true);
  const form = button.closest("form");
  if (!form) throw new Error("Expected the carrier or server form");
  fireEvent.submit(form);
  await waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
  await release();
  expect(currentTransport().carriers).toHaveLength(1);
  expect(panel.getByLabelText("Sign-in")).toHaveProperty("value", "none");
  type(panel, "Sign-in", "mint");
  expect(panel.getByLabelText("Account signing key")).toHaveProperty(
    "value",
    "",
  );
  expect(button).toHaveProperty("disabled", true);
});

it("reenables a refused TURN save without discarding its draft", async () => {
  const originalEdit = transportSeams.edit;
  let first = true;
  transportSeams.edit = async (tomb, apply) => {
    if (first) {
      first = false;
      throw new Error("write failed");
    }
    return originalEdit(tomb, apply);
  };
  const panel = within(render(<LiveRoutesPanel />).container);
  await panel.findByLabelText("STUN or TURN server");
  type(panel, "STUN or TURN server", "turn:first.example.com");
  type(panel, "TURN username", "first-user");
  type(panel, "TURN credential", "first-secret");
  const button = panel.getByRole("button", { name: "Add the server" });
  fireEvent.click(button);
  await panel.findByRole("img", {
    name: "This vault could not keep the change",
  });
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  expect(panel.getByLabelText("TURN credential")).toHaveProperty(
    "value",
    "first-secret",
  );
  fireEvent.click(button);
  await waitFor(() => expect(currentTransport().ice).toHaveLength(1));
});

it("reenables a refused NATS save without discarding its draft", async () => {
  const originalEdit = transportSeams.edit;
  let first = true;
  transportSeams.edit = async (tomb, apply) => {
    if (first) {
      first = false;
      throw new Error("write failed");
    }
    return originalEdit(tomb, apply);
  };
  const panel = within(render(<LiveRoutesPanel />).container);
  await panel.findByLabelText("Code carrier");
  type(panel, "Code carrier", "nats");
  type(panel, "Server (wss://)", "wss://first.example.com");
  type(panel, "Sign-in", "mint");
  type(panel, "Account public key", `A${"B".repeat(55)}`);
  type(panel, "Account signing key", `SA${"C".repeat(56)}`);
  const button = panel.getByRole("button", { name: "Add the carrier" });
  fireEvent.click(button);
  await panel.findByRole("img", {
    name: "This vault could not keep the change",
  });
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  expect(panel.getByLabelText("Account signing key")).toHaveProperty(
    "value",
    `SA${"C".repeat(56)}`,
  );
  fireEvent.click(button);
  await waitFor(() => expect(currentTransport().carriers).toHaveLength(1));
});
