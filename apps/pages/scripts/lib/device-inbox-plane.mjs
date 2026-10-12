/**
 * What `verify-device-inbox.mjs` asks of the device's own plane (ADR 0160,
 * ADR 0162): the host the app itself runs, called by URL so there is one
 * module instance, and the questions asked of it while the vault is shut,
 * open and shut again.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, PATIENCE } from "./device-inbox-tabs.mjs";
import { lockVault } from "./pages-journey.mjs";
import { expect } from "./patient-expect.mjs";

const DIST =
  process.env.PAGES_VERIFY_DIST ??
  fileURLToPath(new URL("../../dist", import.meta.url));

export const hostChunk = () =>
  fs
    .readdirSync(path.join(DIST, "assets"))
    .find((file) => /^device-identity-host-.*\.js$/.test(file));

/** The device host the app itself runs, imported by URL: one module instance. */
export async function planeCall(page, route, init = {}) {
  return page.evaluate(
    async ([url, to, options]) => {
      const host = await import(url);
      const res = await host.deviceIdentityFetch(to, options);
      return { status: res.status, body: await res.json() };
    },
    [`${BASE}/assets/${hostChunk()}`, route, init],
  );
}

/** The locked device shows nothing and answers 423 at the plane. */
export async function lockedDevice(context, width) {
  const page = await context.newPage();
  page.setDefaultTimeout(PATIENCE);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${BASE}/access?view=sessions`);
  const passwordTab = page.getByRole("tab", { name: "Password", exact: true });
  if (await passwordTab.count()) {
    await passwordTab.click();
  }
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/Receipts|Local requests|waiting|Test application/i);
  expect(await page.title()).not.toMatch(/^\(\d+\)/);
  for (const route of ["/v1/audit/events", "/v1/authorization-requests"]) {
    const answer = await planeCall(page, route, {
      headers: { authorization: "Bearer not-a-session" },
    });
    expect(answer.status, `${route} while locked`).toBe(423);
    expect(answer.body.error).toBe("locked");
  }
  await page.close();
}

/** F. The plane says the same, to its own session, and no more. */
export async function planeAnswers(main) {
  const minted = await planeCall(main, "/v1/principals/provisional", {
    method: "POST",
    body: "{}",
  });
  expect(minted.status).toBe(201);
  const asSession = {
    headers: { authorization: `Bearer ${minted.body.accessToken}` },
  };
  const trail = await planeCall(main, "/v1/audit/events?limit=50", asSession);
  expect(trail.status).toBe(200);
  expect(trail.body.pending, "no receipt is left waiting").toBe(0);
  expect(trail.body.events.map((event) => event.eventType)).toEqual(
    expect.arrayContaining([
      "access.request.created",
      "access.request.approved",
      "access.request.withdrawn",
      "access.request.denied",
      "access.sign_in.granted",
      "access.sign_in.revoked",
      "access.sign_in.denied",
    ]),
  );
  expect(JSON.stringify(trail.body)).not.toMatch(
    /records:read|rp\.example|Browser request|Deny this request/,
  );
  const inbox = await planeCall(main, "/v1/authorization-requests", asSession);
  expect(inbox.body.requests).toEqual([]);
  const decided = await planeCall(main, "/v1/authorization-requests", {
    ...asSession,
    method: "POST",
    body: "{}",
  });
  expect(decided.status, "the plane decides nothing").toBe(405);
  return asSession;
}

/** G. Locked again: the session answers 423 and the screen holds nothing. */
export async function lockedAgain(main, asSession) {
  await lockVault(main);
  for (const route of ["/v1/audit/events", "/v1/authorization-requests"]) {
    const answer = await planeCall(main, route, asSession);
    expect(answer.status, `${route} after the lock`).toBe(423);
  }
  expect(await main.locator("body").innerText()).not.toMatch(
    /Receipts|Request approved|Test application/,
  );
}
