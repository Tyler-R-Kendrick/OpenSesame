import { describe, expect, it, vi } from "vitest";

const env = { loopbackPage: true };

import type { TargetState } from "../connectivity-monitor.js";
import {
  classifyHistoryConnector,
  classifyHostConnector,
  classifyIdentityConnector,
  classifyKeysConnector,
  classifyMachineConnector,
} from "../connectors.js";
import type { HostPlane, IdentityPlane, PlaneStatus } from "../planes.js";
import { type FailureClass, failureSentence } from "../probe-failure.js";
import type { PagesSettings } from "../settings.js";
import { settingsSeams } from "../settings.js";

Object.assign(settingsSeams, {
  loadSettings: () => ({}),
  pageIsLoopback: () => env.loopbackPage,
  subscribeSettings: () => () => {},
  settingsEpoch: () => 0,
});

/**
 * Characterization snapshots for everything the connectivity bar says.
 *
 * These do not assert the copy is *right* — the unit tests beside them pin the
 * individual rules. They pin what an operator actually reads, for every state
 * the five connectors can be in, so a change to a label or a tone has to be
 * looked at and accepted rather than discovered in production.
 *
 * This surface drifts silently in a way logic does not. A tone that quietly
 * becomes amber puts a permanent warning in the top bar; a label that quietly
 * stops naming an address takes away the one thing that made it actionable;
 * and a failure sentence that changes meaning sends someone to fix the wrong
 * machine. None of that fails a type check or a behavioural test.
 *
 * If one of these fails, read the diff before updating it.
 */
const HOST_PLANES: HostPlane[] = [
  "live",
  "pending",
  "loopback",
  "down",
  "unset",
];
const IDENTITY_PLANES: IdentityPlane[] = ["connected", "none", "down"];
const FAILURES: Array<FailureClass | null> = [
  null,
  "offline",
  "timeout",
  "unreachable",
  "rejected",
  "server-error",
  "not-opensesame",
];

const HOST_BASE = "http://127.0.0.1:18787";
const IDENTITY_BASE = "http://127.0.0.1:18788";
const DAEMON_BASE = "https://box.tailnet.ts.net";

function plane(over: Partial<PlaneStatus> = {}): PlaneStatus {
  return {
    host: "live",
    hostBase: HOST_BASE,
    identity: "connected",
    identityBase: IDENTITY_BASE,
    ...over,
  };
}

function target(over: Partial<TargetState> = {}): TargetState {
  return {
    health: "reachable",
    failure: null,
    lastCheckedAt: 1_000,
    checking: false,
    ...over,
  };
}

function settings(over: Partial<PagesSettings> = {}): PagesSettings {
  return {
    hostApi: HOST_BASE,
    identityApi: IDENTITY_BASE,
    daemonApi: DAEMON_BASE,
    tursoUrl: "",
    mfaAppUrl: "",
    capabilityConnectors: {
      encryption: { providerId: "webcrypto" },
      history: { providerId: "github" },
    },
    ...over,
  };
}

/** One readable line per case, so a snapshot diff is legible as prose. */
function row(label: string, tone: string, detail: string): string {
  return `${label.padEnd(38)} ${tone.padEnd(8)} ${detail}`;
}

describe("connector copy characterization", () => {
  it("says exactly this for every Host state", () => {
    const lines: string[] = [];
    for (const host of HOST_PLANES) {
      for (const failure of FAILURES) {
        for (const offline of [false, true]) {
          const status = classifyHostConnector(
            plane({ host }),
            target({
              health:
                host === "live" || host === "pending"
                  ? "reachable"
                  : "unreachable",
              failure,
            }),
            offline,
          );
          lines.push(
            row(
              `${host} / ${failure ?? "no-failure"}${offline ? " / offline" : ""}`,
              status.tone,
              status.detail,
            ),
          );
        }
      }
    }
    expect(lines.join("\n")).toMatchSnapshot();
  });

  it("says exactly this for every Host state on a remote page", () => {
    env.loopbackPage = false;
    try {
      const lines = HOST_PLANES.map((host) => {
        const status = classifyHostConnector(
          plane({ host }),
          target({ health: "unreachable", failure: "unreachable" }),
          false,
        );
        return row(host, status.tone, status.detail);
      });
      expect(lines.join("\n")).toMatchSnapshot();
    } finally {
      env.loopbackPage = true;
    }
  });

  it("says exactly this for every Identity state", () => {
    const lines: string[] = [];
    for (const identity of IDENTITY_PLANES) {
      for (const failure of FAILURES) {
        for (const offline of [false, true]) {
          const status = classifyIdentityConnector(
            plane({ identity }),
            target({
              health: identity === "connected" ? "reachable" : "unreachable",
              failure,
            }),
            offline,
          );
          lines.push(
            row(
              `${identity} / ${failure ?? "no-failure"}${offline ? " / offline" : ""}`,
              status.tone,
              status.detail,
            ),
          );
        }
      }
    }
    expect(lines.join("\n")).toMatchSnapshot();
  });

  it("says exactly this for an Identity that was never configured", () => {
    const status = classifyIdentityConnector(
      plane({ identity: "down", identityBase: "" }),
      target({ health: "unreachable" }),
      false,
    );
    expect(row("no base", status.tone, status.detail)).toMatchSnapshot();
  });

  it("says exactly this for every machine state", () => {
    const lines: string[] = [];
    for (const health of ["unknown", "reachable", "unreachable"] as const) {
      for (const failure of FAILURES) {
        for (const offline of [false, true]) {
          const status = classifyMachineConnector(
            target({ health, failure }),
            DAEMON_BASE,
            offline,
          );
          lines.push(
            row(
              `${health} / ${failure ?? "no-failure"}${offline ? " / offline" : ""}`,
              status.tone,
              status.detail,
            ),
          );
        }
      }
    }
    // Unpaired, and paired to something this page could never call.
    lines.push(
      row("unpaired", ...unpair(classifyMachineConnector(target(), "", false))),
    );
    env.loopbackPage = false;
    lines.push(
      row(
        "loopback address, remote page",
        ...unpair(
          classifyMachineConnector(target(), "http://127.0.0.1:18790", false),
        ),
      ),
    );
    env.loopbackPage = true;
    expect(lines.join("\n")).toMatchSnapshot();
  });

  it("says exactly this for every capability binding", () => {
    const lines: string[] = [];
    for (const providerId of ["github", "gitlab", "password-store"]) {
      for (const connectionId of [undefined, "conn_1"]) {
        for (const remote of [
          undefined,
          "https://github.com/owner/store.git",
        ]) {
          const status = classifyHistoryConnector(
            settings({
              capabilityConnectors: {
                encryption: { providerId: "webcrypto" },
                history: { providerId, connectionId, remote },
              },
            }),
          );
          lines.push(
            row(
              `history ${providerId} ${connectionId ?? "unauth"} ${remote ? "remote" : "no-remote"}`,
              status.tone,
              status.detail,
            ),
          );
        }
      }
    }
    for (const providerId of [
      "webcrypto",
      "sealed-local",
      "aws-kms",
      "yubikey",
    ]) {
      for (const connectionId of [undefined, "conn_1"]) {
        const status = classifyKeysConnector(
          settings({
            capabilityConnectors: {
              encryption: { providerId, connectionId },
              history: { providerId: "github" },
            },
          }),
        );
        lines.push(
          row(
            `keys ${providerId} ${connectionId ?? "unauth"}`,
            status.tone,
            status.detail,
          ),
        );
      }
    }
    expect(lines.join("\n")).toMatchSnapshot();
  });

  it("explains every failure class in exactly these words", () => {
    const lines = FAILURES.filter((f): f is FailureClass => f !== null).map(
      (failure) => `${failure.padEnd(16)} ${failureSentence(failure, "Host")}`,
    );
    expect(lines.join("\n")).toMatchSnapshot();
  });
});

/** Snapshot rows want (tone, detail) as a pair. */
function unpair(status: {
  tone: string;
  detail: string;
}): [string, string] {
  return [status.tone, status.detail];
}
