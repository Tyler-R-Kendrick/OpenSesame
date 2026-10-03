/**
 * The connector roads follow what this device can do by itself: Connections
 * switched on or off (the connector pages are routed only while it is on) and
 * a Connect credential held or forgotten. A Host, named or granted, opens
 * nothing (ADR 0151).
 */
/** @vitest-environment jsdom */
import {
  connectRoadSeams,
  notifyConnectRoads,
  resetConnectRoadSeams,
} from "@opensesame/app-core/lib/connect-roads.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { useConnectorRoads } from "./connector-roads.js";

const originalIdentity = { ...identitySeams };
const originalVault = { ...vaultHooksSeams };
const authorizeOnly: Pick<Provider, "id" | "authKind"> = {
  id: "slack",
  authKind: "oauth2_authorization_code",
};
const configuration: Pick<Provider, "id" | "authKind"> = {
  id: "1password",
  authKind: "configuration",
};
const historyRoad = { id: "gitlab" };

beforeEach(() => {
  resetConnectRoadSeams();
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ status: "locked", guest: false, tomb: "personal" }),
  });
});

afterEach(() => {
  cleanup();
  resetConnectRoadSeams();
  Object.assign(identitySeams, originalIdentity);
  Object.assign(vaultHooksSeams, originalVault);
});

describe("connector roads and Connections", () => {
  it("offers a link only once the connector pages are routed, and withdraws it when they go", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useConnectorRoads();
    });
    // Off: no page to link to. A history road keeps the tile's own switch.
    expect(result.current.tile(configuration)).toBeNull();
    expect(result.current.tile(historyRoad)).toBe("switch");

    let seen = renders;
    act(() => {
      connectRoadSeams.pagesOpen = () => true;
      notifyConnectRoads();
    });
    expect(renders).toBeGreaterThan(seen);
    expect(result.current.tile(configuration)).toBe("page");
    expect(result.current.tile(historyRoad)).toBe("page");

    seen = renders;
    act(() => {
      connectRoadSeams.pagesOpen = () => false;
      notifyConnectRoads();
    });
    expect(renders).toBeGreaterThan(seen);
    expect(result.current.tile(configuration)).toBeNull();
    expect(result.current.tile(historyRoad)).toBe("switch");
  });

  it("opens an authorize-only form when Connect holds the provider, and shuts it when Connect lets go", () => {
    const { result } = renderHook(() => useConnectorRoads());
    expect(result.current.form(authorizeOnly)).toBeNull();
    act(() => {
      connectRoadSeams.usesConnect = () => true;
      notifyConnectRoads();
    });
    expect(result.current.form(authorizeOnly)).toBe("connect");
    act(() => {
      connectRoadSeams.usesConnect = () => false;
      notifyConnectRoads();
    });
    expect(result.current.form(authorizeOnly)).toBeNull();
  });

  it("opens no road for a named Host with a live grant", () => {
    identitySeams.hostBase = () => "https://host.example.test";
    identitySeams.hostLocalSessionEligible = () => true;
    const { result } = renderHook(() => useConnectorRoads());
    expect(result.current.form(authorizeOnly)).toBeNull();
    expect(result.current.acts(authorizeOnly)).toBe(false);
    expect(result.current.tile(authorizeOnly)).toBeNull();
  });
});
