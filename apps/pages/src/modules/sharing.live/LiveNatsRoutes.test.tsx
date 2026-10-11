/** @vitest-environment jsdom */
/**
 * A NATS server in the Routes panel (ADR 0167): it signs in with a credential
 * minted per session or a user credential, says whether the session may cross
 * it, and a malformed key is never written. The store is a fake; the panel is
 * not.
 */
import { transportFileText } from "@opensesame/app-core/lib/live/transport.js";
import {
  DIRECT_TRANSPORT,
  type LiveTransport,
  type TransportRead,
} from "@opensesame/app-core/lib/live/transport.js";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LiveRoutesPanel } from "./LiveRoutesPanel.js";
import { transportSeams } from "./live-transport-hooks.js";

const original = { ...transportSeams };
let stored: LiveTransport;

beforeEach(() => {
  stored = DIRECT_TRANSPORT;
  Object.assign(transportSeams, {
    tomb: () => "personal",
    read: async () => stored,
    edit: async (
      _tomb: string,
      apply: (current: LiveTransport) => TransportRead,
    ) => {
      const next = apply(stored);
      if (next.ok) stored = next.transport;
      return next;
    },
  });
});

afterEach(() => {
  cleanup();
  Object.assign(transportSeams, original);
});

type Panel = ReturnType<typeof within>;
const type = (panel: Panel, label: string, value: string) =>
  fireEvent.change(panel.getByLabelText(label), { target: { value } });

async function natsForm(): Promise<Panel> {
  const panel = within(render(<LiveRoutesPanel />).container);
  await panel.findByLabelText("Code carrier");
  type(panel, "Code carrier", "nats");
  type(panel, "Server (wss://)", "wss://nats.example.com");
  return panel;
}

const add = (panel: Panel) =>
  panel.getByRole("button", { name: "Add the carrier" });

describe("a NATS server in the Routes panel", () => {
  it("mints per session from an account signing key, kept out of the link", async () => {
    // Well formed is all the form checks; the session's mint signs with it.
    const account = `A${"B".repeat(55)}`;
    const signingKey = `SA${"C".repeat(56)}`;
    const panel = await natsForm();
    type(panel, "Sign-in", "mint");
    type(panel, "Account public key", "not a key");
    await panel.findByRole("img", { name: "Not an account public key" });
    expect(add(panel)).toHaveProperty("disabled", true);
    type(panel, "Account public key", account);
    type(panel, "Account signing key", signingKey);
    type(panel, "Session over this server", "always");
    fireEvent.click(add(panel));
    await waitFor(() => expect(stored.carriers).toHaveLength(1));
    expect(stored.carriers[0]).toEqual({
      kind: "nats",
      url: "wss://nats.example.com",
      session: "always",
      mint: { account, signingKey },
    });
    expect(transportFileText(stored)).toContain(signingKey);
    // A minted credential is not one the link hands out in the clear.
    expect(
      panel.queryByRole("img", {
        name: "Credentials in this profile travel in the link",
      }),
    ).toBeNull();
  });

  it("takes a user credential, and warns that it travels in the link", async () => {
    const seed = `SU${"D".repeat(56)}`;
    const jwt = `${"a".repeat(20)}.${"b".repeat(40)}.${"c".repeat(20)}`;
    const panel = await natsForm();
    type(panel, "Sign-in", "creds");
    type(panel, "User JWT", jwt);
    expect(add(panel)).toHaveProperty("disabled", true);
    type(panel, "User seed", seed);
    fireEvent.click(add(panel));
    await waitFor(() => expect(stored.carriers).toHaveLength(1));
    expect(stored.carriers[0]).toEqual({
      kind: "nats",
      url: "wss://nats.example.com",
      jwt,
      seed,
    });
    await panel.findByRole("img", {
      name: "Credentials in this profile travel in the link",
    });
  });

  it("changes a server's session route in place, and fallback is the default", async () => {
    stored = {
      ...DIRECT_TRANSPORT,
      carriers: [{ kind: "nats", url: "wss://nats.example.com" }],
    };
    const panel = within(render(<LiveRoutesPanel />).container);
    const choice = await panel.findByLabelText(
      "Session over wss://nats.example.com",
    );
    expect(choice).toHaveProperty("value", "fallback");
    fireEvent.change(choice, { target: { value: "off" } });
    await waitFor(() => expect(stored.carriers[0]?.session).toBe("off"));
    fireEvent.change(
      await panel.findByLabelText("Session over wss://nats.example.com"),
      { target: { value: "fallback" } },
    );
    await waitFor(() => expect(stored.carriers[0]?.session).toBeUndefined());
  });

  it("asks nothing more of a carrier that is not NATS", async () => {
    stored = {
      ...DIRECT_TRANSPORT,
      carriers: [{ kind: "ntfy", url: "https://ntfy.example.com" }],
    };
    const panel = within(render(<LiveRoutesPanel />).container);
    await panel.findByText("https://ntfy.example.com");
    expect(panel.queryByLabelText(/^Session over/)).toBeNull();
    expect(panel.queryByLabelText("Sign-in")).toBeNull();
  });
});
