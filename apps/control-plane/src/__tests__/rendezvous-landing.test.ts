import { overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resetInteractionLinkBudget } from "../routes/interaction-handoff.js";
import { seedOwnedCeremony } from "./seed-ceremony-subject.js";

/**
 * Rendezvous admission and routing (ADR 0086), from the outside.
 *
 * The short-link landing is not a dead end: it continues into a real ceremony,
 * as a launcher into a configured client app or as an address that surfaces in
 * the reader's inbox. And raising an interaction is admitted per requester, so
 * one authenticated principal cannot flood every approver.
 */

type Plane = ReturnType<typeof createControlPlane>;

function plane(clientAppUrl?: string): Plane {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
      ...(clientAppUrl ? { clientAppUrl } : undefined),
    },
  });
}

async function principal(cp: Plane) {
  const res = await cp.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast<unknown, { accessToken: string; principalId: string }>(
    await res.json(),
  );
}

async function inboxRefOf(cp: Plane, who: { accessToken: string }) {
  const res = await cp.app.request("/v1/authorization-requests/inbox-ref", {
    headers: { authorization: `Bearer ${who.accessToken}` },
  });
  expect(res.status).toBe(200);
  return overlapCast<unknown, { approverRef: string }>(await res.json())
    .approverRef;
}

let seq = 0;
async function raise(
  cp: Plane,
  requester: { accessToken: string; principalId: string },
  approverRef: string,
  subjectId: string,
) {
  seedOwnedCeremony(
    cp,
    "device_authorization",
    subjectId,
    requester.principalId,
  );
  return cp.app.request("/v1/interactions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${requester.accessToken}`,
      "content-type": "application/json",
      "idempotency-key": `rz-${++seq}`,
    },
    body: JSON.stringify({
      kind: "device_authorization",
      subject: { kind: "device_authorization", subjectId },
      approverRef,
      authorizationDetails: [
        {
          type: "connection_delegation",
          actions: ["repository.read"],
          locations: ["repo:acme/catalog"],
        },
      ],
      ttlSeconds: 300,
    }),
  });
}

async function createdRef(cp: Plane): Promise<string> {
  const approver = await principal(cp);
  const requester = await principal(cp);
  const res = await raise(
    cp,
    requester,
    await inboxRefOf(cp, approver),
    "dev-session-1",
  );
  expect(res.status).toBe(201);
  return overlapCast<unknown, { ref: string }>(await res.json()).ref;
}

beforeEach(() => {
  resetInteractionLinkBudget();
});

describe("the landing page continues into a real ceremony", () => {
  it("launches into the configured client app under its base path", async () => {
    const cp = plane("https://app.example/OpenSesame/");
    const ref = await createdRef(cp);

    const page = await cp.app.request(`/i/${ref}`, {
      headers: { accept: "text/html" },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    // The launcher carries only the reference, under the client app's base
    // path — never the origin root, never the request.
    expect(html).toContain(`href="https://app.example/OpenSesame/i/${ref}"`);
    expect(html).toContain("Open in OpenSesame");
    expect(html).not.toContain("repo:acme/catalog");
  });

  it("is an address when no client app is configured", async () => {
    const cp = plane();
    const ref = await createdRef(cp);

    const page = await cp.app.request(`/i/${ref}`, {
      headers: { accept: "text/html" },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("appear in your inbox");
    // No launcher: there is no external app to hand the reader to.
    expect(html).not.toContain("https://app.example");
    expect(html).not.toContain("Open in OpenSesame");
  });

  it("refuses to boot with a client-app base carrying credential material", () => {
    // Defence in depth is belt and braces: `resolveContinuation` degrades a
    // bad base to an address at render time (covered in the module's unit
    // tests), but a misconfigured base never gets that far — `assertSecureConfig`
    // fails the boot so a bearer can never be printed into a launcher.
    expect(() => plane("https://app.example/?token=osc_leak")).toThrow();
  });
});

describe("raising an interaction is admitted per requester", () => {
  it("paces a single requester who mints in a loop", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const approverRef = await inboxRefOf(cp, approver);

    let sawRateLimit = false;
    let created = 0;
    for (let i = 0; i < 80 && !sawRateLimit; i += 1) {
      const res = await raise(cp, requester, approverRef, `dev-session-${i}`);
      if (res.status === 201) created += 1;
      if (res.status === 429) {
        expect(await res.json()).toEqual({ error: "rate_limited" });
        sawRateLimit = true;
      }
    }
    // Genuine raises land before the budget bites, and the budget does bite.
    expect(created).toBeGreaterThan(0);
    expect(sawRateLimit).toBe(true);
  });
});
