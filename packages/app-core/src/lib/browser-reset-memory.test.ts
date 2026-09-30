/**
 * Resetting this browser leaves nothing in the tab's memory that describes
 * storage now gone — the kv map (the tomb registry, a vault header) — and
 * clears MSAL's cache through the instances this tab made, while its keys in
 * sessionStorage go by the app's own client ids and another site's stay.
 */

import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import {
  forgetEntraInstancesForTest,
  noteDeployedEntraClients,
  rememberEntraInstance,
} from "./ambient-auth/entra-instances.js";
import {
  applyDeployedAmbientPolicy,
  deployedAmbientProviders,
  resetDeployedAmbientPolicy,
} from "./ambient-auth/runtime.js";
import {
  NO_PORTS,
  SCOPE,
  memoryStorage,
  originRoot,
  ownsCache,
} from "./browser-reset.fixture.js";
import { browserResetSeams, resetBrowser } from "./browser-reset.js";
import { kvGet, kvSet } from "./kv.js";
import { sessionExitSeams } from "./session-exit.js";
import { resumeStorageWritesForTest } from "./storage-halt.js";
import { listTombs } from "./vfs.js";

const original = { signOut: sessionExitSeams.signOut, ...browserResetSeams };
const OURS = "0f1e2d3c-aaaa-4bbb-8ccc-000000000001";
const DEPLOYED = "5e5e5e5e-bbbb-4ccc-8ddd-000000000003";
const THEIRS = "9a8b7c6d-dddd-4eee-8fff-000000000002";

afterEach(() => {
  sessionExitSeams.signOut = original.signOut;
  browserResetSeams.networkAnswers = original.networkAnswers;
  forgetEntraInstancesForTest();
  resetDeployedAmbientPolicy();
  resumeStorageWritesForTest();
  configureHost(createTestHost());
});

function quiet(): void {
  sessionExitSeams.signOut = () => undefined;
  browserResetSeams.networkAnswers = async () => true;
}

describe("resetBrowser: this tab's memory", () => {
  it("forgets every kv copy, so the tomb registry lists nothing erased", async () => {
    quiet();
    configureHost(
      createTestHost({
        ...NO_PORTS,
        originFiles: async () => overlapCast(originRoot([])),
      }),
    );
    kvSet("tombs.v1", JSON.stringify({ tombs: ["personal", "project-4f2a"] }));
    kvSet("tomb/personal/vault.header.v1", "{}");
    expect(listTombs()).toContain("project-4f2a");

    await resetBrowser({ scope: SCOPE, ownsCache });

    expect(kvGet("tombs.v1")).toBeNull();
    expect(kvGet("tomb/personal/vault.header.v1")).toBeNull();
    expect(listTombs()).not.toContain("project-4f2a");
  });
});

describe("resetBrowser: MSAL", () => {
  it("clears each instance this tab made, and only the app's clients' keys", async () => {
    quiet();
    const clearCache = vi.fn(async () => undefined);
    rememberEntraInstance(OURS, clearCache);
    applyDeployedAmbientPolicy({
      providers: [
        {
          issuer: "https://login.microsoftonline.com/t/v2.0",
          clientId: DEPLOYED,
        },
      ],
    });
    noteDeployedEntraClients(
      deployedAmbientProviders().map((provider) => provider.clientId),
    );
    const session = memoryStorage(
      [`msal.${OURS}.request.params`, "{}"],
      [`msal.3.token.keys.${OURS}`, "{}"],
      [`server-telemetry-${OURS}`, "{}"],
      [`appmetadata-login.windows.net-${DEPLOYED}`, "{}"],
      [`throttling.${JSON.stringify({ clientId: DEPLOYED })}`, "{}"],
      [`msal.${THEIRS}.request.params`, "{}"],
      [`msal.3.token.keys.${THEIRS}`, "{}"],
      [`server-telemetry-${THEIRS}`, "{}"],
    );
    configureHost(createTestHost({ ...NO_PORTS, storage: { session } }));

    await resetBrowser({ scope: SCOPE, ownsCache });

    expect(clearCache).toHaveBeenCalledTimes(1);
    expect([...session.map.keys()]).toEqual([
      `msal.${THEIRS}.request.params`,
      `msal.3.token.keys.${THEIRS}`,
      `server-telemetry-${THEIRS}`,
    ]);
  });

  it("goes on when an instance never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      quiet();
      rememberEntraInstance(OURS, () => new Promise(() => undefined));
      configureHost(createTestHost({ ...NO_PORTS }));
      const done = resetBrowser({ scope: SCOPE, ownsCache });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(done).resolves.toMatchObject({ failed: [] });
    } finally {
      vi.useRealTimers();
    }
  });
});
