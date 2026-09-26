/**
 * Opening a drop: what the presentation sends and how each refusal reads.
 * Ported from the ceremonies app's `lib/drop.test.ts` ("presentDrop") and
 * `pages/DropAcceptance.test.tsx`, against Pages' drop path — which used to
 * collapse every refusal to `refused`.
 */
import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deviceIdentityFetch,
  resetDeviceIdentitySessionsForTests,
} from "../device-identity-host.js";
import { identitySeams } from "../identity.js";
import {
  createDrop,
  dropSeams,
  openDrop,
  presentDrop,
  sealDrop,
} from "./drop.js";
import {
  localDropClaimSeams,
  resetLocalDropClaimsForTests,
} from "./local-drop-claims.js";

const identityFetch =
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const original = { ...identitySeams };
const originalDrop = { ...dropSeams };

beforeEach(() => {
  identityFetch.mockReset();
  Object.assign(identitySeams, {
    identityFetch,
    identityBase: () => "http://127.0.0.1:8788",
  });
});

afterEach(() => {
  Object.assign(identitySeams, original);
  Object.assign(dropSeams, originalDrop);
});

function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TEXT = { kind: "text" as const, name: "Deploy token", text: "s3cr3t" };

describe("presenting a drop to the Identity API", () => {
  it("posts token and user code only, and returns the manifest", async () => {
    const { manifest, fragmentKey } = await sealDrop(TEXT);
    identityFetch.mockResolvedValueOnce(
      json({ id: "clm_1", state: "presented", targetManifest: manifest }),
    );
    const presented = await presentDrop("osc_clm_a.b", "ABCD-EFGH");
    await expect(
      openDrop(presented.targetManifest, fragmentKey),
    ).resolves.toEqual(TEXT);
    const [path, init] = identityFetch.mock.calls.at(-1) ?? ["", {}];
    expect(path).toBe("/v1/claims/present");
    const body = String(init?.body ?? "");
    // The bearer and the fragment key went nowhere near the address, and the
    // key went nowhere near the request.
    expect(path).not.toContain("osc_clm_");
    expect(body).not.toContain(fragmentKey);
    expect(JSON.parse(body)).toEqual({
      token: "osc_clm_a.b",
      userCode: "ABCD-EFGH",
    });
  });

  it("maps every refusal onto a recipient-readable error", async () => {
    const cases: Array<[BoundaryValue, number, string, RegExp]> = [
      [
        { error: "invalid_user_code" },
        401,
        "invalid_code",
        /did not match this drop/,
      ],
      [
        { error: "too_many_attempts" },
        429,
        "invalid_code",
        /Too many wrong codes/,
      ],
      [{ error: "EXPIRED" }, 410, "expired", /expired before it was opened/],
      [
        { error: "INVALID_TRANSITION" },
        422,
        "already_opened",
        /^This drop was already opened\.$/,
      ],
      [{}, 404, "invalid", /not valid/],
      [{ error: "invalid_token" }, 401, "invalid", /not valid/],
      [{}, 500, "unreachable", /\(500\)/],
    ];
    for (const [body, status, code, words] of cases) {
      identityFetch.mockResolvedValueOnce(json(body, status));
      await expect(
        presentDrop("osc_clm_a.b", "c"),
        JSON.stringify(body),
      ).rejects.toMatchObject({ code, message: expect.stringMatching(words) });
    }
  });

  it("keeps an unreachable plane and a payload-less answer apart", async () => {
    identityFetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(presentDrop("osc_clm_a.b", "c")).rejects.toMatchObject({
      code: "unreachable",
    });
    identityFetch.mockResolvedValueOnce(json({ id: "clm_1" }));
    await expect(presentDrop("osc_clm_a.b", "c")).rejects.toMatchObject({
      code: "refused",
    });
  });
});

describe("presenting a drop to this device's claim plane", () => {
  let live: JsonObject | null = null;

  beforeEach(() => {
    resetLocalDropClaimsForTests();
    resetDeviceIdentitySessionsForTests();
    localDropClaimSeams.claimBase = () => "http://localhost:5180/OpenSesame";
    dropSeams.claimBase = () => "http://localhost:5180/OpenSesame";
    live = null;
    Object.assign(identitySeams, {
      currentSession: () => live,
      connectProvisional: async () => {
        const res = await deviceIdentityFetch("/v1/principals/provisional", {
          method: "POST",
          body: "{}",
        });
        const body: JsonObject = overlapCast(await res.json());
        live = {
          principalId: String(body.principalId),
          accessToken: String(body.accessToken),
          issuerOrigin: "https://device.identity.local",
        };
        return live;
      },
    });
    identityFetch.mockImplementation(async (path, init = {}) => {
      const headers = new Headers(init.headers);
      if (live)
        headers.set("authorization", `Bearer ${String(live.accessToken)}`);
      return deviceIdentityFetch(path, { ...init, headers });
    });
  });

  afterEach(() => {
    resetLocalDropClaimsForTests();
    resetDeviceIdentitySessionsForTests();
  });

  it("keeps the drop unburned on a wrong code, then burns it exactly once", async () => {
    const created = await createDrop({
      name: "Deploy token",
      payload: TEXT,
      ttlMs: 600_000,
      keepCopy: false,
    });
    const params = new URLSearchParams(new URL(created.link).hash.slice(1));
    const token = String(params.get("token"));

    await expect(presentDrop(token, "WRONG-CODE")).rejects.toMatchObject({
      code: "invalid_code",
      message: "That code does not match this drop.",
    });
    const opened = await presentDrop(token, created.userCode);
    await expect(
      openDrop(opened.targetManifest, String(params.get("key"))),
    ).resolves.toEqual(TEXT);
    await expect(presentDrop(token, created.userCode)).rejects.toMatchObject({
      code: "already_opened",
    });
  });

  it("says a drop sealed elsewhere is not on this device", async () => {
    await expect(
      presentDrop("osc_clm_nowhere.secret", "c"),
    ).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringMatching(/not on this device/),
    });
  });
});
