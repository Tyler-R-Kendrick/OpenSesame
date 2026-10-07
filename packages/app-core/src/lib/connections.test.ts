/**
 * What `connections.ts` does on a device that speaks no Host (ADR 0128,
 * ADR 0151): every road it takes is the browser's own, and a call no road can
 * take is refused with its reason, never sent anywhere.
 */
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import {
  ConnectionsError,
  authorizeConnection,
  awaitConsent,
  createConnection,
  getConnection,
  listConnections,
  revokeConnection,
  setConnectionConfiguration,
  setConnectionCredential,
} from "./connections.js";
import { forgetDeviceConnectors } from "./device-connectors.js";
import { identitySeams } from "./identity.js";
import { vaultStore } from "./vault/store.js";

const originalIdentity = { ...identitySeams };
const hostFetch = vi.fn();
const origin = "https://app.example.test";

type MessageListener = (event: MessageEvent) => void;
let listeners: MessageListener[] = [];

function installPage() {
  listeners = [];
  configureHost(
    createTestHost({
      page: overlapCast({
        location: { origin, href: `${origin}/OpenSesame/` },
        addEventListener: (_type: string, listener: MessageListener) => {
          listeners.push(listener);
        },
        removeEventListener: (_type: string, listener: MessageListener) => {
          listeners = listeners.filter((held) => held !== listener);
        },
        open: () => null,
      }),
    }),
  );
}

beforeEach(async () => {
  hostFetch.mockReset();
  installPage();
  await vaultStore.createGuest({ resume: false });
  // A Host is named and a grant is live: it still takes no connection call.
  identitySeams.hostBase = () => "https://host.example.test";
  identitySeams.hostLocalSessionEligible = () => true;
  identitySeams.hostFetch = hostFetch;
});

afterEach(async () => {
  await forgetDeviceConnectors();
  vaultStore.lock();
  Object.assign(identitySeams, originalIdentity);
  configureHost(createTestHost());
  vi.useRealTimers();
});

describe("making a connection", () => {
  it("seals a key connector on this device, and nothing is sent", async () => {
    const made = await createConnection({
      providerId: "anthropic",
      displayName: "Work key",
    });
    expect(made.connectionRef).toBe(`local/connector/${made.connectionId}`);
    await setConnectionCredential(made.connectionId, "sk-test");
    expect(await getConnection(made.connectionId)).toMatchObject({
      providerId: "anthropic",
      status: "active",
    });
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("seals a configuration connector on this device", async () => {
    const made = await createConnection({ providerId: "passwordstate" });
    const sealed = await setConnectionConfiguration(made.connectionId, {
      base_url: "https://passwords.example.test",
    });
    expect(sealed.providerId).toBe("passwordstate");
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("refuses an authorize-only provider no road holds, saying why", async () => {
    await expect(createConnection({ providerId: "slack" })).rejects.toEqual(
      expect.objectContaining({
        name: "ConnectionsError",
        code: "unavailable",
        message: expect.not.stringMatching(/host/i),
      }),
    );
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("refuses a git remote: it is saved from its own form", async () => {
    await expect(
      createConnection({ providerId: "gitlab" }),
    ).rejects.toBeInstanceOf(ConnectionsError);
  });

  it("refuses to authorize a connection nothing can authorize", async () => {
    const made = await createConnection({ providerId: "anthropic" });
    await expect(authorizeConnection(made.connectionId)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(hostFetch).not.toHaveBeenCalled();
  });
});

describe("reading and revoking", () => {
  it("lists what this device holds without asking anything else", async () => {
    const made = await createConnection({ providerId: "anthropic" });
    const rows = await listConnections();
    expect(rows.map((row) => row.connectionId)).toContain(made.connectionId);
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("says a connection that is not here is not here", async () => {
    await expect(getConnection("conn_unknown")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(revokeConnection("conn_unknown")).rejects.toMatchObject({
      status: 404,
    });
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("revokes a device connection", async () => {
    const made = await createConnection({ providerId: "anthropic" });
    expect(await revokeConnection(made.connectionId)).toEqual({
      revoked: true,
      providerRevocation: "ok",
    });
    await expect(getConnection(made.connectionId)).rejects.toBeInstanceOf(
      ConnectionsError,
    );
  });
});

describe("waiting for consent", () => {
  it("does not need a Host named: it settles on the app's own origin", async () => {
    identitySeams.hostBase = () => "";
    const made = await createConnection({ providerId: "anthropic" });
    vi.useFakeTimers();
    const outcome = awaitConsent(made.connectionId, null);
    // Connect tells its opener from the app's origin, so that is the one a
    // message may come from.
    await vi.advanceTimersByTimeAsync(0);
    for (const listener of listeners) {
      listener(
        new MessageEvent("message", {
          origin,
          data: {
            type: "opensesame:connection",
            connectionId: made.connectionId,
          },
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(1600);
    expect(await outcome).toMatchObject({ result: "active" });
    expect(listeners).toHaveLength(0);
  });

  it("ignores a message from any other origin and settles on the poll", async () => {
    const made = await createConnection({ providerId: "anthropic" });
    vi.useFakeTimers();
    const outcome = awaitConsent(made.connectionId, null);
    await vi.advanceTimersByTimeAsync(0);
    for (const listener of listeners) {
      listener(
        new MessageEvent("message", {
          origin: "https://host.example.test",
          data: { type: "opensesame:connection", connectionId: "other" },
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(1600);
    expect(await outcome).toMatchObject({ result: "active" });
  });

  it("abandons when the popup closes first", async () => {
    vi.useFakeTimers();
    const outcome = awaitConsent("conn_pending", overlapCast({ closed: true }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(await outcome).toEqual({ result: "abandoned" });
  });
});
