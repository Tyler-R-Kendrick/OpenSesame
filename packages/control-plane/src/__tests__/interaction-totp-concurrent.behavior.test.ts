import { expect, it } from "vitest";
import {
  approve,
  ceremony,
  complete,
  enrolled,
  pending,
} from "./interaction-totp.test-support.js";
import { headers, pinClock } from "./mfa-step-up-fixture.js";

pinClock();

it("two independently raised requests cannot spend the same real authenticator step to activate both", async () => {
  const first = await ceremony();
  const second = await ceremony("device_authorization", first);
  const factor = await enrolled(first);
  const original = await pending(first);
  const independent = await pending(second);
  const results = await Promise.all([
    complete(first, original, factor.code),
    complete(second, independent, factor.code),
  ]);
  expect(results.map((response) => response.status).sort()).toEqual([200, 401]);
  const rows = await Promise.all([
    first.cp.ctx.repos.approvalActivations.getById(original),
    first.cp.ctx.repos.approvalActivations.getById(independent),
  ]);
  expect(rows.map((row) => row?.state).sort()).toEqual([
    "activated",
    "pending",
  ]);
  const winner = rows[0]?.state === "activated" ? first : second;
  const winningId = rows[0]?.state === "activated" ? original : independent;
  const loser = winner === first ? second : first;
  const losingId = winner === first ? independent : original;
  expect((await approve(winner, winningId)).status).toBe(200);
  const refused = await approve(loser, losingId);
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect(
    (await first.cp.ctx.repos.interactions.getById(winner.id))?.status,
  ).toBe("approved");
  expect(
    (await first.cp.ctx.repos.interactions.getById(loser.id))?.status,
  ).not.toBe("approved");
  expect(
    await first.cp.ctx.repos.approvalActivations.getById(losingId),
  ).toMatchObject({ state: "pending" });
});

it("an activated authentic factor cannot reverse a terminal human denial or spend its device subject", async () => {
  const f = await ceremony();
  const factor = await enrolled(f);
  const activationId = await pending(f);
  expect((await complete(f, activationId, factor.code)).status).toBe(200);
  const denied = await f.cp.app.request(`/v1/interactions/${f.ref}/deny`, {
    method: "POST",
    headers: headers(f.approver.accessToken),
    body: JSON.stringify({ requestDigest: f.requestDigest }),
  });
  expect(denied.status).toBe(200);
  const before = structuredClone(
    await f.cp.ctx.repos.interactions.getById(f.id),
  );
  const subject = structuredClone(
    f.cp.ctx.stores.ceremonySubjects.getDevice(f.subjectId),
  );
  const attempted = await approve(f, activationId);
  expect(attempted.status).toBeGreaterThanOrEqual(400);
  expect(await f.cp.ctx.repos.interactions.getById(f.id)).toEqual(before);
  const consumed = await f.cp.app.request(`/v1/interactions/${f.ref}/consume`, {
    method: "POST",
    headers: headers(f.requester.accessToken),
  });
  expect(consumed.status).toBeGreaterThanOrEqual(400);
  expect(f.cp.ctx.stores.ceremonySubjects.getDevice(f.subjectId)).toEqual(
    subject,
  );
  expect(before?.status).toBe("denied");
});
