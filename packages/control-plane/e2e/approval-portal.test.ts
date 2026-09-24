import { once } from "node:events";
import { serve } from "@hono/node-server";
import { isString, overlapCast } from "@opensesame/os-domain";
import {
  type Browser,
  type LaunchOptions,
  type Page,
  chromium,
} from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlPlane } from "../src/create-app.js";

let plane: ReturnType<typeof createControlPlane>;
let browser: Browser;
let origin = "";
const server = serve({
  fetch: (request) => plane.app.fetch(request),
  hostname: "127.0.0.1",
  port: 0,
});

beforeAll(async () => {
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || isString(address)) throw new Error("Fixture did not bind");
  origin = `http://localhost:${address.port}`;
  plane = createControlPlane({
    config: { publicUrl: origin, issuer: origin, allowDevDefaults: false },
    processEnv: { OPENSESAME_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
  });
  const launchOptions: LaunchOptions = { headless: true };
  if (process.env.OPENSESAME_TEST_CHROMIUM_PATH)
    launchOptions.executablePath = process.env.OPENSESAME_TEST_CHROMIUM_PATH;
  browser = await chromium.launch(launchOptions);
});
afterAll(async () => {
  await browser?.close();
  server.close();
  await once(server, "close");
});

async function principal() {
  const response = await plane.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(response.status).toBe(201);
  return overlapCast(await response.json());
}

async function fixture() {
  const approver = await principal();
  const requester = await principal();
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: plane.ctx.config.provisionalCookieName,
      value: approver.accessToken,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const opener = await context.newPage();
  await opener.goto(
    `${origin.replace("localhost", "127.0.0.1")}/v1/health/live`,
  );
  const waiting = context.waitForEvent("page");
  await opener.evaluate((url) => {
    window.open(url);
  }, `${origin}/v1/health/live`);
  const page = await waiting;
  await page.waitForLoadState();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await enroll(page);
  const inbox = await plane.app.request(
    "/v1/authorization-requests/inbox-ref",
    {
      headers: { authorization: `Bearer ${approver.accessToken}` },
    },
  );
  const approverRef = overlapCast(await inbox.json()).approverRef;
  const create = async (verb: string) => {
    const response = await plane.app.request("/v1/authorization-requests", {
      method: "POST",
      headers: {
        authorization: `Bearer ${requester.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        approverRef,
        bindingMessage: `Review fixture ${verb}`,
        authorizationDetails: [
          {
            type: "connection_delegation",
            actions: ["repository.write"],
            locations: ["repo:fixture/owned"],
          },
        ],
      }),
    });
    expect(response.status).toBe(201);
    return overlapCast(await response.json());
  };
  return { context, page, approver, create };
}

async function enroll(page: Page) {
  await page.evaluate(async () => {
    const post = async (path: string, body: string) => {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!response.ok)
        throw new Error(`Enrollment refused: ${response.status}`);
      return response.json();
    };
    const registration = await post(
      "/v1/mfa/passkey/registration-options",
      "{}",
    );
    const credential = await navigator.credentials.create({
      publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(
        registration.options,
      ),
    });
    if (!(credential instanceof PublicKeyCredential))
      throw new Error("Missing passkey");
    await post(
      "/v1/mfa/passkey/register",
      JSON.stringify({ response: credential.toJSON() }),
    );
  });
}

function ceremony(id: string, digest: string, decision: string) {
  const url = new URL("/v1/approval/ceremony", origin);
  url.searchParams.set("request", id);
  url.searchParams.set("digest", digest);
  url.searchParams.set("decision", decision);
  return url.href;
}

it("cross-origin portal approvals and denials use real Identity-origin WebAuthn and persist the exact decision", async () => {
  const { context, page, approver, create } = await fixture();
  try {
    for (const decision of ["approve", "deny"]) {
      const request = await create(decision);
      const url = ceremony(request.authReqId, request.requestDigest, decision);
      const response = await page.goto(url);
      expect(response?.headers()["content-security-policy"]).toContain(
        "frame-ancestors 'none'",
      );
      const action = page.getByRole("button", {
        name: decision === "approve" ? "Verify and approve" : "Verify and deny",
        exact: true,
      });
      await action.waitFor();
      expect(await action.isEnabled()).toBe(true);
      await action.click();
      await page
        .getByText("Decision recorded. Return to Access.", { exact: true })
        .waitFor();
      const recorded = await plane.app.request(
        `/v1/authorization-requests/${request.authReqId}`,
        {
          headers: { authorization: `Bearer ${approver.accessToken}` },
        },
      );
      expect(await recorded.json()).toMatchObject({
        status: decision === "approve" ? "approved" : "denied",
        requestDigest: request.requestDigest,
      });
      const replay = await plane.app.request(
        `/v1/authorization-requests/${request.authReqId}/${decision}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${approver.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ requestDigest: request.requestDigest }),
        },
      );
      expect(replay.status).not.toBe(200);
    }
  } finally {
    await context.close();
  }
});

it("a changed digest and a cancelled authenticator leave the request pending", async () => {
  const { context, page, approver, create } = await fixture();
  try {
    const request = await create("cancel");
    await page.goto(ceremony(request.authReqId, "wrong-digest", "approve"));
    await page.getByText(/Approval unavailable/).waitFor();
    expect(await page.locator("#approve").isDisabled()).toBe(true);
    await page.goto(
      ceremony(request.authReqId, request.requestDigest, "approve"),
    );
    await page
      .getByRole("button", { name: "Verify and approve", exact: true })
      .waitFor();
    await page.evaluate(() => {
      Object.defineProperty(navigator.credentials, "get", {
        value: async () => null,
        configurable: true,
      });
    });
    await page
      .getByRole("button", { name: "Verify and approve", exact: true })
      .click();
    await page.getByText(/Approval unavailable/).waitFor();
    const recorded = await plane.app.request(
      `/v1/authorization-requests/${request.authReqId}`,
      {
        headers: { authorization: `Bearer ${approver.accessToken}` },
      },
    );
    expect(await recorded.json()).toMatchObject({ status: "pending" });
    await context.clearCookies();
    await page.goto(
      ceremony(request.authReqId, request.requestDigest, "approve"),
    );
    await page.getByText(/Approval unavailable/).waitFor();
    expect(await page.locator("#approve").isDisabled()).toBe(true);
  } finally {
    await context.close();
  }
});
