/**
 * Local IAM's vouching for the device principal (ADR 0160): a live passkey
 * session held by this tab, and nothing else.
 */

import { describe, expect, it } from "vitest";
import { LOCAL_IAM_DEVICE_ROUTES } from "./device-identity-local.js";
import {
  type LocalSessionPort,
  localPasskeyAssurance,
  passkeyAssuranceFrom,
} from "./local-iam-assurance.js";
import type { LocalSession } from "./local-sessions.js";

const row = (
  principalId: string,
  authentication: LocalSession["authentication"],
  authTime = 1000,
): LocalSession => ({
  id: `s-${principalId}`,
  principalId,
  authentication,
  authTime,
  expiresAt: authTime + 900_000,
});

/** A faithful port: lists what is recorded, holds what this tab holds. */
function portOf(
  recorded: readonly LocalSession[],
  held: readonly string[],
): LocalSessionPort & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    list: async () => recorded,
    current: async (_tomb, principalId) => {
      asked.push(principalId);
      return held.includes(principalId)
        ? (recorded.find((s) => s.principalId === principalId) ?? null)
        : null;
    },
  };
}

describe("passkeyAssuranceFrom", () => {
  it("vouches, with the authentication time, for a passkey session this tab holds", async () => {
    const port = portOf([row("local_a", "passkey", 4242)], ["local_a"]);
    expect(await passkeyAssuranceFrom(port)("personal")).toEqual({
      level: "phishing_resistant",
      verifiedAt: 4242,
    });
  });

  it("does not vouch for an agent key session, and does not even look", async () => {
    const port = portOf([row("local_agent", "agent_key")], ["local_agent"]);
    expect(await passkeyAssuranceFrom(port)("personal")).toBeNull();
    expect(port.asked).toEqual([]);
  });

  it("does not vouch for a record this tab does not hold", async () => {
    const port = portOf([row("local_a", "passkey")], []);
    expect(await passkeyAssuranceFrom(port)("personal")).toBeNull();
  });

  it("looks past a record it does not hold to one it does", async () => {
    const port = portOf(
      [row("local_a", "passkey"), row("local_b", "passkey", 9)],
      ["local_b"],
    );
    expect(await passkeyAssuranceFrom(port)("personal")).toEqual({
      level: "phishing_resistant",
      verifiedAt: 9,
    });
    expect(port.asked).toEqual(["local_a", "local_b"]);
  });

  it("vouches for nothing with no session", async () => {
    expect(await passkeyAssuranceFrom(portOf([], []))("personal")).toBeNull();
  });

  it("vouches for nothing when sessions cannot be read", async () => {
    const unreadable: LocalSessionPort = {
      list: async () => {
        throw new Error("locked");
      },
      current: async () => null,
    };
    expect(await passkeyAssuranceFrom(unreadable)("personal")).toBeNull();
  });

  it("vouches for nothing on a real, empty vault session store", async () => {
    // The real port against a tomb with no sessions or no Web Locks: no proof.
    expect(await localPasskeyAssurance("never-unlocked")).toBeNull();
  });
});

describe("what identity.local-iam contributes", () => {
  it("serves the directory, audit and requests families, and vouches by passkey", () => {
    expect(LOCAL_IAM_DEVICE_ROUTES.id).toBe("identity.local-iam");
    expect([...LOCAL_IAM_DEVICE_ROUTES.serves]).toEqual([
      "directory",
      "audit",
      "requests",
    ]);
    expect(LOCAL_IAM_DEVICE_ROUTES.assurance).toBe(localPasskeyAssurance);
  });

  it("still answers the email and text code routes with its refusal", async () => {
    const res = await LOCAL_IAM_DEVICE_ROUTES.dispatch({
      path: "/v1/mfa/code/send",
      bare: "/v1/mfa/code/send",
      method: "POST",
      init: {},
      caller: null,
    });
    expect(res?.status).toBe(503);
  });
});
