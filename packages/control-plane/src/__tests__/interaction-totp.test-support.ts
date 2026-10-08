import { createHmac, randomUUID } from "node:crypto";
import {
  type InteractionKind,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { expect } from "vitest";
import {
  type FactoryPlane,
  factoryInboxRef,
  factoryPlane,
  factoryPrincipal,
  factoryRaise,
} from "./interaction-factory-helpers.js";
import { enrolTotp, headers } from "./mfa-step-up-fixture.js";

type Actor = Awaited<ReturnType<typeof factoryPrincipal>>;
export type Ceremony = {
  cp: FactoryPlane;
  approver: Actor;
  requester: Actor;
  subjectId: string;
  ref: string;
  requestDigest: string;
  id: string;
};

export function authenticatorCode(secret: string, at = Date.now()) {
  const step = Buffer.alloc(8);
  step.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", Buffer.from(secret, "base64"))
    .update(step)
    .digest();
  const offset = (mac.at(-1) ?? 0) & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(
    6,
    "0",
  );
}

export function invalidAuthenticatorCode(secret: string, at = Date.now()) {
  const accepted = new Set(
    [-30_000, 0, 30_000].map((offset) =>
      authenticatorCode(secret, at + offset),
    ),
  );
  const candidate = ["000000", "000001", "000002", "000003"].find(
    (code) => !accepted.has(code),
  );
  if (candidate === undefined)
    throw new Error("no invalid fixture code available");
  return candidate;
}

export async function ceremony(
  kind: InteractionKind = "device_authorization",
  previous?: Ceremony,
) {
  const cp = previous?.cp ?? factoryPlane();
  const approver = previous?.approver ?? (await factoryPrincipal(cp));
  const requester = previous?.requester ?? (await factoryPrincipal(cp));
  const subjectId = `totp-subject-${randomUUID()}`;
  const raised = await factoryRaise(
    cp,
    requester,
    await factoryInboxRef(cp, approver.accessToken),
    kind,
    subjectId,
  );
  expect(raised.status).toBe(201);
  const created: { ref: string; requestDigest: string } = overlapCast(
    await raised.json(),
  );
  const detail = await cp.app.request(`/v1/interactions/${created.ref}`, {
    headers: headers(approver.accessToken),
  });
  expect(detail.status).toBe(200);
  const row: { id: string } = overlapCast(await detail.json());
  return { cp, approver, requester, subjectId, ...created, id: row.id };
}

export async function begin(f: Ceremony, method = "totp") {
  return f.cp.app.request(`/v1/interactions/${f.ref}/activation`, {
    method: "POST",
    headers: headers(f.approver.accessToken),
    body: JSON.stringify({
      decision: "approved",
      requestDigest: f.requestDigest,
      method,
    }),
  });
}

export async function pending(f: Ceremony) {
  const response = await begin(f);
  expect(response.status).toBe(201);
  const body: { activationId: string } = overlapCast(await response.json());
  expect(
    await f.cp.ctx.repos.approvalActivations.getById(body.activationId),
  ).toMatchObject({
    state: "pending",
    method: "totp",
    authReqId: f.id,
    principalId: f.approver.principalId,
  });
  return body.activationId;
}

export function complete(
  f: Ceremony,
  activationId: string,
  code: string,
  token = f.approver.accessToken,
) {
  return f.cp.app.request(`/v1/interactions/${f.ref}/activation/totp`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ activationId, code }),
  });
}

export function approve(f: Ceremony, activationId: string) {
  return f.cp.app.request(`/v1/interactions/${f.ref}/approve`, {
    method: "POST",
    headers: headers(f.approver.accessToken),
    body: JSON.stringify({ requestDigest: f.requestDigest, activationId }),
  });
}

export async function enrolled(f: Ceremony) {
  const secret = await enrolTotp(f.cp, f.approver.accessToken);
  return { secret, code: authenticatorCode(secret) };
}

export async function refusal(
  response: Response,
  status: number,
  error: string,
) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error });
}

export async function unchanged(
  f: Ceremony,
  activationId: string,
  before: JsonObject,
) {
  const row = await f.cp.ctx.repos.approvalActivations.getById(activationId);
  expect(row).toMatchObject(before);
  const interaction = await f.cp.ctx.repos.interactions.getById(f.id);
  expect(interaction?.status).not.toBe("approved");
  expect(interaction).not.toHaveProperty("approvalProof");
}
