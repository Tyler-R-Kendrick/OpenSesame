/** @vitest-environment jsdom */
import {
  ConnectionsError,
  type Provider,
  connectionSeams,
} from "@opensesame/app-core/lib/connections.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import {
  HOST_CONNECTIONS_WRITE,
  hostGrantSeams,
} from "@opensesame/app-core/lib/host-grant.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectForm } from "./ConnectForm.js";
import { makeConnection } from "./section-fixtures.test-support.js";

const originalSeams = { ...connectionSeams };
const originalIdentity = { ...identitySeams };
const originalGrant = { ...hostGrantSeams };

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

function provider(id: string): Provider {
  const found = getBundledProviders().find((row) => row.id === id);
  if (!found) throw new Error(`${id} is not bundled`);
  return found;
}

/** A Host is named and this browser holds an approved grant to it. */
function openHostRoad() {
  identitySeams.hostBase = () => "https://host.test";
  identitySeams.hostLocalSessionEligible = () => true;
  hostGrantSeams.capabilities = () => [HOST_CONNECTIONS_WRITE];
}

const refusal = new ConnectionsError(403, "refused", "Host said no.");

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
});

afterEach(() => {
  cleanup();
  clearNotices();
  Object.assign(connectionSeams, originalSeams);
  Object.assign(identitySeams, originalIdentity);
  Object.assign(hostGrantSeams, originalGrant);
  vi.unstubAllGlobals();
});

function drawBetterAuth() {
  const onFlash = vi.fn();
  const onConnected = vi.fn();
  render(
    <ConnectForm
      provider={provider("better-auth")}
      online
      onFlash={onFlash}
      onConnected={onConnected}
    />,
  );
  return { onFlash, onConnected };
}

async function fillBetterAuth() {
  await userEvent.type(
    screen.getByLabelText(/Base URL/),
    "https://auth.example.com/api/auth",
  );
  await userEvent.type(
    screen.getByLabelText(/^API key \(required\)/),
    "ba_key",
  );
}

describe("a configuration form with no road open", () => {
  it("is drawn on this device", () => {
    const { onFlash } = drawBetterAuth();
    expect(
      screen.getByRole("button", { name: /Save configuration/ }),
    ).toBeTruthy();
    expect(screen.getByLabelText(/Base URL/)).toBeTruthy();
    expect(onFlash).not.toHaveBeenCalled();
  });

  it("is drawn once a Host is open", () => {
    openHostRoad();
    drawBetterAuth();
    expect(
      screen.getByRole("button", { name: /Save configuration/ }),
    ).toBeTruthy();
  });
});

describe("a configuration save that fails", () => {
  beforeEach(openHostRoad);

  it("keeps everything the person typed", async () => {
    const create = vi.fn().mockRejectedValue(refusal);
    connectionSeams.createConnection = create;
    const { onConnected } = drawBetterAuth();
    await fillBetterAuth();
    await userEvent.click(
      screen.getByRole("button", { name: /Save configuration/ }),
    );
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(screen.getByLabelText(/Base URL/)).toHaveProperty(
      "value",
      "https://auth.example.com/api/auth",
    );
    expect(screen.getByLabelText(/^API key \(required\)/)).toHaveProperty(
      "value",
      "ba_key",
    );
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("says why beside the key that was pressed", async () => {
    connectionSeams.createConnection = vi.fn().mockRejectedValue(refusal);
    drawBetterAuth();
    await fillBetterAuth();
    await userEvent.click(
      screen.getByRole("button", { name: /Save configuration/ }),
    );
    const mark = await screen.findByRole("img", { name: "Host said no." });
    expect(mark.closest(".go-row")).not.toBeNull();
  });

  it("also puts the sentence in the bell, where it can be read", async () => {
    connectionSeams.createConnection = vi.fn().mockRejectedValue(refusal);
    drawBetterAuth();
    await fillBetterAuth();
    await userEvent.click(
      screen.getByRole("button", { name: /Save configuration/ }),
    );
    await waitFor(() =>
      expect(listNotices()).toMatchObject([
        {
          id: "connector:better-auth",
          tone: "err",
          title: "Better Auth",
          body: "Host said no.",
        },
      ]),
    );
  });

  it("retries into the connection the failed try made, then clears the sentence", async () => {
    const created = makeConnection({ providerId: "better-auth" });
    const create = vi.fn().mockResolvedValue(created);
    connectionSeams.createConnection = create;
    connectionSeams.setConnectionConfiguration = vi
      .fn()
      .mockRejectedValueOnce(refusal)
      .mockResolvedValue(created);
    const { onConnected, onFlash } = drawBetterAuth();
    await fillBetterAuth();
    const save = screen.getByRole("button", { name: /Save configuration/ });
    await userEvent.click(save);
    await screen.findByRole("img", { name: "Host said no." });
    // The page is not asked to reload: it would swap this form for the
    // half-made connection's card and take the typed values with it.
    expect(onConnected).not.toHaveBeenCalled();
    await userEvent.click(save);
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledTimes(1);
    expect(connectionSeams.setConnectionConfiguration).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("img", { name: "Host said no." })).toBeNull();
    expect(listNotices()).toEqual([]);
    expect(onFlash).toHaveBeenCalledWith({
      tone: "ok",
      text: "Better Auth configuration saved.",
    });
    // Sealed now: the secret does not stay in the form.
    expect(screen.getByLabelText(/^API key \(required\)/)).toHaveProperty(
      "value",
      "",
    );
  });
});

describe("an API key save that fails", () => {
  beforeEach(openHostRoad);

  it("keeps the key the person pasted and says why beside the key", async () => {
    const created = makeConnection({ providerId: "lithic" });
    connectionSeams.createConnection = vi.fn().mockResolvedValue(created);
    connectionSeams.setConnectionCredential = vi
      .fn()
      .mockRejectedValue(refusal);
    const onConnected = vi.fn();
    render(
      <ConnectForm
        provider={provider("lithic")}
        online
        onFlash={vi.fn()}
        onConnected={onConnected}
      />,
    );
    await userEvent.type(screen.getByLabelText("API key"), "lk_secret");
    await userEvent.click(
      screen.getByRole("button", { name: /Connect Lithic/ }),
    );
    await screen.findByRole("img", { name: "Host said no." });
    expect(screen.getByLabelText("API key")).toHaveProperty(
      "value",
      "lk_secret",
    );
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("is drawn on this device with no road open", () => {
    Object.assign(identitySeams, originalIdentity);
    Object.assign(hostGrantSeams, originalGrant);
    render(
      <ConnectForm
        provider={provider("lithic")}
        online
        onFlash={vi.fn()}
        onConnected={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("API key")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Connect Lithic/ })).toBeTruthy();
  });
});
